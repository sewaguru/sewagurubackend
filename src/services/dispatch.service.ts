import { prisma } from "../lib/prisma";
import { config } from "../config/config";
import {
  BookingProfessionalOfferStatus,
  DispatchStatus,
  NotificationType,
} from "../generated/prisma";
import {
  createNotification,
  notifyBranchAdmins,
} from "./notification.service";
import { findEligibleProfessionalsForBooking } from "./dispatchMatching.service";

const log = (event: string, data?: Record<string, unknown>) => {
  console.log("[DISPATCH]", event, data ?? {});
};

const logError = (event: string, data?: Record<string, unknown>) => {
  console.error("[DISPATCH]", event, data ?? {});
};

//////////////////////////////////////////////////////
// SEND ONE BATCH (idempotent: safe to call repeatedly for the same booking
// — findEligibleProfessionalsForBooking always excludes already-offered
// professionals, so a repeat call either sends the *next* batch or no-ops
// if nothing has changed since the last attempt would still find the same
// candidates)
//////////////////////////////////////////////////////

const sendBatch = async (bookingId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      displayId: true,
      branchId: true,
      status: true,
      isActive: true,
      assignedProfessionalId: true,
      dispatchedAt: true,
      items: {
        select: { serviceNode: { select: { name: true } } },
      },
    },
  });

  if (
    !booking ||
    !booking.isActive ||
    booking.assignedProfessionalId ||
    booking.status === "CANCELLED"
  ) {
    log("SKIP_NO_LONGER_DISPATCHABLE", { bookingId });
    return;
  }

  const bookingRef = booking.displayId ?? booking.id;
  const serviceNames =
    booking.items
      .map((item) => item.serviceNode?.name)
      .filter((name): name is string => Boolean(name))
      .join(", ") || "your requested service";

  const eligible = await findEligibleProfessionalsForBooking(bookingId);

  if (eligible.length === 0) {
    const previousOfferCount = await prisma.bookingProfessionalOffer.count({
      where: { bookingId },
    });

    const terminalStatus =
      previousOfferCount > 0
        ? DispatchStatus.EXPIRED_UNFILLED
        : DispatchStatus.NO_ELIGIBLE_PROFESSIONALS;

    await prisma.booking.update({
      where: { id: bookingId },
      data: { dispatchStatus: terminalStatus },
    });

    try {
      await notifyBranchAdmins(booking.branchId, {
        type: NotificationType.DISPATCH_NO_PROFESSIONALS,
        title: `No professionals available (${bookingRef})`,
        message:
          previousOfferCount > 0
            ? `No professional accepted the offer for ${serviceNames}, and no further eligible professionals were found.`
            : `No eligible professionals were found for ${serviceNames}.`,
        linkUrl: `/dashboard/bookings/${booking.id}`,
        data: { bookingId: booking.id },
      });
    } catch (error) {
      logError("NO_PROFESSIONALS_NOTIFY_FAILED", { bookingId, error });
    }

    log("NO_ELIGIBLE_PROFESSIONALS", { bookingId, terminalStatus });
    return;
  }

  const batch = eligible.slice(0, config.DISPATCH_BATCH_SIZE);

  const lastBatch = await prisma.bookingProfessionalOffer.aggregate({
    where: { bookingId },
    _max: { batchNumber: true },
  });
  const batchNumber = (lastBatch._max.batchNumber ?? 0) + 1;

  const expiresAt = new Date(
    Date.now() + config.DISPATCH_OFFER_TTL_MINUTES * 60 * 1000
  );

  let createdOffers: Array<{ id: string; professionalId: string }>;

  try {
    createdOffers = await prisma.$transaction(
      batch.map((candidate) =>
        prisma.bookingProfessionalOffer.create({
          data: {
            bookingId,
            professionalId: candidate.professionalId,
            status: BookingProfessionalOfferStatus.SENT,
            batchNumber,
            distanceKm: candidate.distanceKm,
            sentAt: new Date(),
            expiresAt,
          },
          select: { id: true, professionalId: true },
        })
      )
    );
  } catch (error) {
    // Leave dispatchStatus untouched (still IN_PROGRESS or OFFERS_SENT from
    // a prior round) so the sweep's stuck-in-progress retry can pick this
    // booking back up rather than silently losing it.
    logError("OFFER_CREATE_FAILED", { bookingId, error });
    throw error;
  }

  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      dispatchStatus: DispatchStatus.OFFERS_SENT,
      dispatchedAt: booking.dispatchedAt ?? new Date(),
      dispatchAttempts: { increment: 1 },
    },
  });

  log("BATCH_SENT", {
    bookingId,
    batchNumber,
    offeredProfessionalCount: createdOffers.length,
  });

  // Push notifications are best-effort per professional — one failure must
  // never prevent the others in the batch from being notified.
  await Promise.all(
    batch.map(async (candidate) => {
      try {
        await createNotification({
          userId: candidate.userId,
          type: NotificationType.JOB_OFFER_RECEIVED,
          title: "New job nearby",
          message: `${serviceNames} · about ${candidate.distanceKm.toFixed(
            1
          )} km away`,
          linkUrl: "/professional/job-offers",
          data: {
            bookingId: booking.id,
            distanceKm: candidate.distanceKm,
          },
        });
      } catch (error) {
        logError("OFFER_NOTIFY_FAILED", {
          bookingId,
          professionalId: candidate.professionalId,
          error,
        });
      }
    })
  );
};

//////////////////////////////////////////////////////
// TRIGGER (called once per booking-placed event; idempotent)
//////////////////////////////////////////////////////

export const triggerDispatchForBooking = async (bookingId: string) => {
  // Conditional update: only the caller that actually flips
  // NOT_DISPATCHED -> IN_PROGRESS proceeds. If the same booking-placed
  // event fires twice (retry, duplicate webhook, etc.), the second call
  // affects 0 rows and safely no-ops.
  const claim = await prisma.booking.updateMany({
    where: { id: bookingId, dispatchStatus: DispatchStatus.NOT_DISPATCHED },
    data: { dispatchStatus: DispatchStatus.IN_PROGRESS },
  });

  if (claim.count === 0) {
    log("ALREADY_DISPATCHED_OR_NOT_APPLICABLE", { bookingId });
    return;
  }

  try {
    await sendBatch(bookingId);
  } catch (error) {
    logError("INITIAL_DISPATCH_FAILED", { bookingId, error });
    // dispatchStatus stays IN_PROGRESS; the sweep's stuck-in-progress path
    // will retry it.
  }
};

//////////////////////////////////////////////////////
// CANCEL (customer cancelled the booking while dispatch was live)
//////////////////////////////////////////////////////

export const cancelDispatchForBooking = async (bookingId: string) => {
  await prisma.bookingProfessionalOffer.updateMany({
    where: {
      bookingId,
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

  await prisma.booking.updateMany({
    where: {
      id: bookingId,
      dispatchStatus: { not: DispatchStatus.ASSIGNED },
    },
    data: { dispatchStatus: DispatchStatus.CANCELLED },
  });
};

//////////////////////////////////////////////////////
// CONTINUE (called after a reject / ineligible-at-accept-time cancellation
// so dispatch doesn't have to wait for the next sweep tick if the booking
// has no other live offers left)
//////////////////////////////////////////////////////

export const continueDispatchIfNoLiveOffers = async (
  bookingId: string
) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      isActive: true,
      assignedProfessionalId: true,
      status: true,
      dispatchStatus: true,
    },
  });

  if (
    !booking ||
    !booking.isActive ||
    booking.assignedProfessionalId ||
    booking.status === "CANCELLED" ||
    booking.dispatchStatus === DispatchStatus.CANCELLED
  ) {
    return;
  }

  const stillLive = await prisma.bookingProfessionalOffer.count({
    where: {
      bookingId,
      status: {
        in: [
          BookingProfessionalOfferStatus.SENT,
          BookingProfessionalOfferStatus.VIEWED,
          BookingProfessionalOfferStatus.ACCEPTED,
        ],
      },
    },
  });

  if (stillLive === 0) {
    await sendBatch(bookingId);
  }
};

//////////////////////////////////////////////////////
// SWEEP (expire stale offers, advance to next batch, retry stuck rounds)
//////////////////////////////////////////////////////

export const sweepDispatch = async () => {
  const now = new Date();

  const expiredOffers = await prisma.bookingProfessionalOffer.updateMany({
    where: {
      status: {
        in: [
          BookingProfessionalOfferStatus.SENT,
          BookingProfessionalOfferStatus.VIEWED,
        ],
      },
      expiresAt: { lt: now },
    },
    data: {
      status: BookingProfessionalOfferStatus.EXPIRED,
      respondedAt: now,
    },
  });

  const awaitingNextBatch = await prisma.booking.findMany({
    where: {
      dispatchStatus: DispatchStatus.OFFERS_SENT,
      isActive: true,
      assignedProfessionalId: null,
      status: { not: "CANCELLED" },
    },
    select: { id: true },
  });

  let redispatchedCount = 0;

  for (const { id } of awaitingNextBatch) {
    const stillLive = await prisma.bookingProfessionalOffer.count({
      where: {
        bookingId: id,
        status: {
          in: [
            BookingProfessionalOfferStatus.SENT,
            BookingProfessionalOfferStatus.VIEWED,
            BookingProfessionalOfferStatus.ACCEPTED,
          ],
        },
      },
    });

    if (stillLive === 0) {
      try {
        await sendBatch(id);
        redispatchedCount += 1;
      } catch (error) {
        logError("SWEEP_REDISPATCH_FAILED", { bookingId: id, error });
      }
    }
  }

  // A booking stuck IN_PROGRESS (e.g. the process crashed mid-round)
  // longer than the configured timeout is retried. `updatedAt` is a
  // pragmatic proxy for "time of last dispatch activity" here — an
  // unrelated booking edit could reset it, which only delays a retry by
  // one more sweep cycle, never causes incorrect data.
  const stuckThreshold = new Date(
    now.getTime() - config.DISPATCH_STUCK_IN_PROGRESS_MINUTES * 60 * 1000
  );

  const stuckInProgress = await prisma.booking.findMany({
    where: {
      dispatchStatus: DispatchStatus.IN_PROGRESS,
      updatedAt: { lt: stuckThreshold },
      isActive: true,
      status: { not: "CANCELLED" },
    },
    select: { id: true },
  });

  let stuckRetriedCount = 0;

  for (const { id } of stuckInProgress) {
    try {
      await sendBatch(id);
      stuckRetriedCount += 1;
    } catch (error) {
      logError("SWEEP_STUCK_RETRY_FAILED", { bookingId: id, error });
    }
  }

  return {
    expiredOfferCount: expiredOffers.count,
    redispatchedCount,
    stuckRetriedCount,
  };
};

//////////////////////////////////////////////////////
// BACKGROUND JOB (same in-process interval pattern as trash/notification
// campaign jobs)
//////////////////////////////////////////////////////

export const startDispatchSweepJob = () => {
  const runSweep = () => {
    void sweepDispatch()
      .then((result) => {
        if (
          result.expiredOfferCount > 0 ||
          result.redispatchedCount > 0 ||
          result.stuckRetriedCount > 0
        ) {
          log("SWEEP_COMPLETE", result);
        }
      })
      .catch((error) => {
        logError("SWEEP_FAILED", { error });
      });
  };

  runSweep();

  const timer = setInterval(runSweep, config.DISPATCH_SWEEP_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
};
