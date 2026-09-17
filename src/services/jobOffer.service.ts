import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import {
  BookingProfessionalOfferStatus,
  DispatchStatus,
  NotificationType,
} from "../generated/prisma";
import { getGoOnlineEligibility } from "./professionalAvailability.service";
import {
  findProfessionalIdsWithSchedulingConflict,
} from "./dispatchMatching.service";
import { continueDispatchIfNoLiveOffers } from "./dispatch.service";
import { createNotification } from "./notification.service";
import { getProfessionalProfileById } from "./professional.service";

//////////////////////////////////////////////////////
// INTERNAL CONTROL-FLOW SIGNALS
//////////////////////////////////////////////////////
// Thrown *inside* the $transaction callback to trigger an automatic
// rollback, then caught outside to build the right AppError. Using
// distinct classes (rather than string matching) keeps the two "lost the
// race" cases unambiguous.

class OfferClaimFailedError extends Error {}
class BookingClaimFailedError extends Error {}

const log = (event: string, data?: Record<string, unknown>) => {
  console.log("[JOB_OFFER]", event, data ?? {});
};

const logError = (event: string, data?: Record<string, unknown>) => {
  console.error("[JOB_OFFER]", event, data ?? {});
};

const OWN_OFFER_SELECT = {
  id: true,
  bookingId: true,
  professionalId: true,
  status: true,
  expiresAt: true,
  booking: {
    select: {
      id: true,
      displayId: true,
      userId: true,
      status: true,
      scheduledAt: true,
      assignedProfessionalId: true,
    },
  },
} as const;

const loadOwnOffer = async (offerId: string, professionalId: string) => {
  const offer = await prisma.bookingProfessionalOffer.findFirst({
    where: { id: offerId, professionalId },
    select: OWN_OFFER_SELECT,
  });

  if (!offer) {
    throw new AppError("Job offer not found.", 404, "OFFER_NOT_FOUND");
  }

  return offer;
};

const invalidateOwnOfferAndContinueDispatch = async (
  offerId: string,
  bookingId: string
) => {
  await prisma.bookingProfessionalOffer.updateMany({
    where: {
      id: offerId,
      status: {
        in: [
          BookingProfessionalOfferStatus.SENT,
          BookingProfessionalOfferStatus.VIEWED,
        ],
      },
    },
    data: {
      status: BookingProfessionalOfferStatus.CANCELLED,
      respondedAt: new Date(),
    },
  });

  void continueDispatchIfNoLiveOffers(bookingId).catch((error) => {
    logError("CONTINUE_DISPATCH_FAILED", { bookingId, error });
  });
};

//////////////////////////////////////////////////////
// ACCEPT
//////////////////////////////////////////////////////

export const acceptJobOffer = async ({
  offerId,
  professionalId,
}: {
  offerId: string;
  professionalId: string;
}) => {
  const offer = await loadOwnOffer(offerId, professionalId);

  //////////////////////////////////////////////////////
  // FAST, CLEAR PRE-CHECKS (before ever opening a transaction)
  //////////////////////////////////////////////////////

  // Idempotency: this professional already won this booking — succeed
  // silently instead of erroring on a duplicate/retried request.
  if (
    offer.status === BookingProfessionalOfferStatus.ACCEPTED &&
    offer.booking.assignedProfessionalId === professionalId
  ) {
    log("ACCEPT_IDEMPOTENT_ALREADY_ACCEPTED", { offerId, professionalId });
    return { booking: offer.booking, alreadyAccepted: true as const };
  }

  if (offer.booking.status === "CANCELLED") {
    throw new AppError(
      "This booking was cancelled by the customer.",
      409,
      "BOOKING_CANCELLED"
    );
  }

  if (
    offer.booking.assignedProfessionalId &&
    offer.booking.assignedProfessionalId !== professionalId
  ) {
    throw new AppError(
      "This booking has already been assigned to another professional.",
      409,
      "BOOKING_ALREADY_ASSIGNED"
    );
  }

  if (offer.status === BookingProfessionalOfferStatus.REJECTED) {
    throw new AppError(
      "You have already rejected this job offer.",
      409,
      "OFFER_ALREADY_REJECTED"
    );
  }

  if (offer.status === BookingProfessionalOfferStatus.CANCELLED) {
    throw new AppError(
      "This job offer is no longer available.",
      409,
      "OFFER_NOT_AVAILABLE"
    );
  }

  if (
    offer.status === BookingProfessionalOfferStatus.EXPIRED ||
    (offer.expiresAt && offer.expiresAt.getTime() < Date.now())
  ) {
    throw new AppError(
      "This job offer has expired.",
      410,
      "OFFER_EXPIRED"
    );
  }

  if (
    offer.status !== BookingProfessionalOfferStatus.SENT &&
    offer.status !== BookingProfessionalOfferStatus.VIEWED
  ) {
    throw new AppError(
      "This job offer is no longer available.",
      409,
      "OFFER_NOT_AVAILABLE"
    );
  }

  //////////////////////////////////////////////////////
  // RE-VALIDATE ELIGIBILITY AT ACCEPT TIME (not just at dispatch time)
  //////////////////////////////////////////////////////

  const profile = await getProfessionalProfileById(professionalId);

  if (!profile) {
    throw new AppError("Professional profile not found.", 404);
  }

  const eligibility = getGoOnlineEligibility(profile);

  if (!eligibility.eligible) {
    await invalidateOwnOfferAndContinueDispatch(offerId, offer.bookingId);
    throw new AppError(eligibility.reason, 403, eligibility.code);
  }

  if (profile.availabilityStatus !== "ONLINE") {
    await invalidateOwnOfferAndContinueDispatch(offerId, offer.bookingId);
    throw new AppError(
      "You are not currently online.",
      403,
      "NOT_ONLINE"
    );
  }

  const conflicted = await findProfessionalIdsWithSchedulingConflict({
    professionalIds: [professionalId],
    scheduledAt: offer.booking.scheduledAt,
    excludeBookingId: offer.bookingId,
  });

  if (conflicted.has(professionalId)) {
    await invalidateOwnOfferAndContinueDispatch(offerId, offer.bookingId);
    throw new AppError(
      "You have a conflicting job scheduled around this time.",
      409,
      "SCHEDULE_CONFLICT"
    );
  }

  //////////////////////////////////////////////////////
  // ATOMIC ASSIGNMENT
  //////////////////////////////////////////////////////

  try {
    const assignedBooking = await prisma.$transaction(async (tx) => {
      // Step 1: claim the BOOKING row first — before touching any offer
      // row, including this professional's own. This ordering matters: if
      // every concurrent accept attempt locks the booking row before any
      // offer row, there is a single, total lock order across all of them
      // (booking, then offers), which makes a deadlock impossible. Doing
      // it the other way around (own-offer-then-booking) lets a winner's
      // "invalidate the other offers" step try to lock a loser's offer row
      // while that loser is simultaneously blocked trying to lock the
      // booking row while already holding its own offer row's lock — a
      // textbook circular wait.
      const bookingClaim = await tx.booking.updateMany({
        where: {
          id: offer.bookingId,
          assignedProfessionalId: null,
          status: { not: "CANCELLED" },
        },
        data: {
          assignedProfessionalId: professionalId,
          assignedAt: new Date(),
          dispatchStatus: DispatchStatus.ASSIGNED,
          status: "TECHNICIAN_ASSIGNED",
        },
      });

      if (bookingClaim.count === 0) {
        throw new BookingClaimFailedError();
      }

      // Step 2: claim this professional's own offer row. We already won
      // the booking, so this only fails if our own offer became invalid
      // (expired/responded) in the narrow window since the pre-checks —
      // throwing here rolls back step 1 too, so the booking is never left
      // assigned without a genuinely-accepted offer backing it.
      const offerClaim = await tx.bookingProfessionalOffer.updateMany({
        where: {
          id: offerId,
          professionalId,
          status: {
            in: [
              BookingProfessionalOfferStatus.SENT,
              BookingProfessionalOfferStatus.VIEWED,
            ],
          },
          expiresAt: { gt: new Date() },
        },
        data: {
          status: BookingProfessionalOfferStatus.ACCEPTED,
          respondedAt: new Date(),
        },
      });

      if (offerClaim.count === 0) {
        throw new OfferClaimFailedError();
      }

      // updateMany can't create nested relations, so the timeline entry is
      // a separate write — safe here because it only runs once we've
      // already won the conditional update above.
      await tx.bookingTimeline.create({
        data: {
          bookingId: offer.bookingId,
          status: "TECHNICIAN_ASSIGNED",
          message: "A professional accepted and was assigned.",
        },
      });

      // Step 3: invalidate every other still-live offer for this booking.
      // Safe from the same deadlock shape as above — by this point we
      // already hold the booking-row lock, so any concurrent accept for
      // another professional is still blocked on step 1 and has not yet
      // touched its own offer row.
      await tx.bookingProfessionalOffer.updateMany({
        where: {
          bookingId: offer.bookingId,
          id: { not: offerId },
          status: {
            in: [
              BookingProfessionalOfferStatus.PENDING,
              BookingProfessionalOfferStatus.SENT,
              BookingProfessionalOfferStatus.VIEWED,
            ],
          },
        },
        data: {
          status: BookingProfessionalOfferStatus.CANCELLED,
          respondedAt: new Date(),
        },
      });

      return tx.booking.findUniqueOrThrow({
        where: { id: offer.bookingId },
      });
    });

    log("ACCEPTED", {
      offerId,
      professionalId,
      bookingId: offer.bookingId,
    });

    try {
      await createNotification({
        userId: assignedBooking.userId,
        type: NotificationType.BOOKING_STATUS_UPDATED,
        title: `Professional assigned (${
          assignedBooking.displayId ?? assignedBooking.id
        })`,
        message: "A professional has been assigned to your booking.",
        linkUrl: `/orders/${assignedBooking.id}`,
        data: {
          bookingId: assignedBooking.id,
          status: "TECHNICIAN_ASSIGNED",
        },
      });
    } catch (error) {
      logError("CUSTOMER_NOTIFY_FAILED", {
        bookingId: assignedBooking.id,
        error,
      });
    }

    return { booking: assignedBooking, alreadyAccepted: false as const };
  } catch (error) {
    if (error instanceof BookingClaimFailedError) {
      // Re-inspect current state to give a precise, honest message rather
      // than a generic failure.
      const freshBooking = await prisma.booking.findUnique({
        where: { id: offer.bookingId },
      });

      if (freshBooking?.assignedProfessionalId === professionalId) {
        // A concurrent duplicate of this same request won in between our
        // pre-checks and this attempt's transaction — still idempotently
        // a success, not an error.
        return { booking: freshBooking, alreadyAccepted: true as const };
      }

      if (freshBooking?.status === "CANCELLED") {
        throw new AppError(
          "This booking was cancelled by the customer.",
          409,
          "BOOKING_CANCELLED"
        );
      }

      throw new AppError(
        "This booking has already been assigned to another professional.",
        409,
        "BOOKING_ALREADY_ASSIGNED"
      );
    }

    if (error instanceof OfferClaimFailedError) {
      // We won the booking claim, but this professional's own offer turned
      // out invalid in the same instant (e.g. it expired, or a concurrent
      // reject raced this same accept) — the whole transaction rolled
      // back, including the booking claim, so nothing is left assigned
      // without a genuinely-accepted offer behind it.
      const fresh = await prisma.bookingProfessionalOffer.findUnique({
        where: { id: offerId },
      });

      if (fresh?.status === BookingProfessionalOfferStatus.EXPIRED) {
        throw new AppError(
          "This job offer has expired.",
          410,
          "OFFER_EXPIRED"
        );
      }

      throw new AppError(
        "This job offer is no longer available.",
        409,
        "OFFER_NOT_AVAILABLE"
      );
    }

    throw error;
  }
};

//////////////////////////////////////////////////////
// REJECT
//////////////////////////////////////////////////////

export const rejectJobOffer = async ({
  offerId,
  professionalId,
  note,
}: {
  offerId: string;
  professionalId: string;
  note?: string | null;
}) => {
  const offer = await loadOwnOffer(offerId, professionalId);

  if (offer.status === BookingProfessionalOfferStatus.REJECTED) {
    return { offer, alreadyRejected: true as const };
  }

  if (offer.status === BookingProfessionalOfferStatus.ACCEPTED) {
    throw new AppError(
      "You have already accepted this job offer.",
      409,
      "OFFER_ALREADY_ACCEPTED"
    );
  }

  if (offer.status === BookingProfessionalOfferStatus.EXPIRED) {
    throw new AppError(
      "This job offer has expired.",
      410,
      "OFFER_EXPIRED"
    );
  }

  if (offer.status === BookingProfessionalOfferStatus.CANCELLED) {
    throw new AppError(
      "This job offer is no longer available.",
      409,
      "OFFER_NOT_AVAILABLE"
    );
  }

  const trimmedNote =
    typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;

  const claim = await prisma.bookingProfessionalOffer.updateMany({
    where: {
      id: offerId,
      professionalId,
      status: {
        in: [
          BookingProfessionalOfferStatus.SENT,
          BookingProfessionalOfferStatus.VIEWED,
        ],
      },
    },
    data: {
      status: BookingProfessionalOfferStatus.REJECTED,
      respondedAt: new Date(),
      responseNote: trimmedNote,
    },
  });

  if (claim.count === 0) {
    const fresh = await prisma.bookingProfessionalOffer.findUnique({
      where: { id: offerId },
    });

    if (fresh?.status === BookingProfessionalOfferStatus.REJECTED) {
      return { offer: fresh, alreadyRejected: true as const };
    }

    throw new AppError(
      "This job offer is no longer available.",
      409,
      "OFFER_NOT_AVAILABLE"
    );
  }

  log("REJECTED", { offerId, professionalId });

  void continueDispatchIfNoLiveOffers(offer.bookingId).catch((error) => {
    logError("CONTINUE_DISPATCH_FAILED", {
      bookingId: offer.bookingId,
      error,
    });
  });

  const updated = await prisma.bookingProfessionalOffer.findUniqueOrThrow({
    where: { id: offerId },
  });

  return { offer: updated, alreadyRejected: false as const };
};
