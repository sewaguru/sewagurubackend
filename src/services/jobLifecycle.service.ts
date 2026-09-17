import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { BookingStatus, NotificationType } from "../generated/prisma";
import { createNotification } from "./notification.service";
import { sendBookingCompletionEmail } from "./emailManagement.service";
import { ensureEarningForBooking } from "./earnings.service";
import { recordJobOutcome } from "./professionalStats.service";

//////////////////////////////////////////////////////
// JOB LIFECYCLE STATE MACHINE
//////////////////////////////////////////////////////
// Assigned -> Start Travel -> Arrived -> Start Work -> Complete. Strictly
// linear and server-validated — each action is only valid from the exact
// preceding state, matching the flow as specified (no skipping steps).
//////////////////////////////////////////////////////

export type JobLifecycleAction =
  | "startTravel"
  | "arrive"
  | "startWork"
  | "complete";

type TransitionRule = {
  from: BookingStatus;
  to: BookingStatus;
  timelineMessage: string;
  customerMessage: string;
};

const TRANSITIONS: Record<JobLifecycleAction, TransitionRule> = {
  startTravel: {
    from: BookingStatus.TECHNICIAN_ASSIGNED,
    to: BookingStatus.TECHNICIAN_EN_ROUTE,
    timelineMessage: "Professional started traveling to the location.",
    customerMessage: "Your professional is on the way.",
  },
  arrive: {
    from: BookingStatus.TECHNICIAN_EN_ROUTE,
    to: BookingStatus.TECHNICIAN_ARRIVED,
    timelineMessage: "Professional arrived at the location.",
    customerMessage: "Your professional has arrived at your location.",
  },
  startWork: {
    from: BookingStatus.TECHNICIAN_ARRIVED,
    to: BookingStatus.WORK_IN_PROGRESS,
    timelineMessage: "Professional started the work.",
    customerMessage: "Work has started on your booking.",
  },
  complete: {
    from: BookingStatus.WORK_IN_PROGRESS,
    to: BookingStatus.COMPLETED,
    timelineMessage: "Professional marked the work as completed.",
    customerMessage: "Your booking has been completed.",
  },
};

// A professional can back out before work actually starts (emergency,
// vehicle breakdown, etc). Once work has started, this simple self-service
// cancel is no longer available — that requires escalation, not a solo
// backend endpoint. Cancelling here ends the booking outright; it does not
// attempt to re-dispatch to another professional (a materially bigger
// feature not covered by this phase).
const CANCELLABLE_FROM_STATUSES: BookingStatus[] = [
  BookingStatus.TECHNICIAN_ASSIGNED,
  BookingStatus.TECHNICIAN_EN_ROUTE,
  BookingStatus.TECHNICIAN_ARRIVED,
];

const log = (event: string, data?: Record<string, unknown>) => {
  console.log("[JOB_LIFECYCLE]", event, data ?? {});
};

const logError = (event: string, data?: Record<string, unknown>) => {
  console.error("[JOB_LIFECYCLE]", event, data ?? {});
};

const OWN_ASSIGNED_BOOKING_SELECT = {
  id: true,
  displayId: true,
  userId: true,
  status: true,
  isActive: true,
  assignedProfessionalId: true,
} as const;

const loadOwnAssignedBooking = async (
  bookingId: string,
  professionalId: string
) => {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, assignedProfessionalId: professionalId },
    select: OWN_ASSIGNED_BOOKING_SELECT,
  });

  // A booking that exists but isn't assigned to this professional returns
  // the same 404 as one that doesn't exist at all — never reveal that
  // another professional's booking exists.
  if (!booking) {
    throw new AppError("Booking not found.", 404, "BOOKING_NOT_FOUND");
  }

  return booking;
};

const notifyCustomer = async (
  booking: { id: string; displayId: string | null; userId: string },
  status: BookingStatus,
  message: string
) => {
  try {
    await createNotification({
      userId: booking.userId,
      type: NotificationType.BOOKING_STATUS_UPDATED,
      title: `Booking update (${booking.displayId ?? booking.id})`,
      message,
      linkUrl: `/orders/${booking.id}`,
      data: { bookingId: booking.id, status },
    });
  } catch (error) {
    logError("CUSTOMER_NOTIFY_FAILED", { bookingId: booking.id, error });
  }
};

//////////////////////////////////////////////////////
// ADVANCE (startTravel / arrive / startWork / complete)
//////////////////////////////////////////////////////

export const advanceJobStatus = async ({
  bookingId,
  professionalId,
  professionalUserId,
  action,
}: {
  bookingId: string;
  professionalId: string;
  professionalUserId: string;
  action: JobLifecycleAction;
}) => {
  const rule = TRANSITIONS[action];
  const booking = await loadOwnAssignedBooking(bookingId, professionalId);

  // Idempotent retry: already in the target state from a prior successful
  // call (network retry / double-tap) — succeed silently.
  if (booking.status === rule.to) {
    log("ADVANCE_IDEMPOTENT", { bookingId, action });
    return { booking, alreadyInState: true as const };
  }

  if (booking.status === BookingStatus.CANCELLED) {
    throw new AppError(
      "This booking has been cancelled.",
      409,
      "BOOKING_CANCELLED"
    );
  }

  if (booking.status === BookingStatus.COMPLETED) {
    throw new AppError(
      "This booking has already been completed.",
      409,
      "BOOKING_COMPLETED"
    );
  }

  if (booking.status !== rule.from) {
    throw new AppError(
      `Cannot ${action} while the booking is ${booking.status}. Expected ${rule.from}.`,
      409,
      "INVALID_JOB_TRANSITION"
    );
  }

  const claim = await prisma.booking.updateMany({
    where: {
      id: bookingId,
      assignedProfessionalId: professionalId,
      status: rule.from,
    },
    data: { status: rule.to },
  });

  if (claim.count === 0) {
    // Something changed between the check above and this write (extremely
    // unlikely for a single-assignee resource, but handled the same
    // conditional-update-safe way as everywhere else in this codebase).
    const fresh = await prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (fresh?.status === rule.to) {
      return { booking: fresh, alreadyInState: true as const };
    }

    throw new AppError(
      `Cannot ${action} — booking is no longer in the expected state.`,
      409,
      "INVALID_JOB_TRANSITION"
    );
  }

  await prisma.bookingTimeline.create({
    data: {
      bookingId,
      status: rule.to,
      message: rule.timelineMessage,
      createdById: professionalUserId,
    },
  });

  log("ADVANCED", { bookingId, action, to: rule.to });

  await notifyCustomer(booking, rule.to, rule.customerMessage);

  if (action === "complete") {
    // Reuse the exact same completion side effect the existing admin
    // status-update path already triggers — no separate completion
    // system. ServiceReview submission is already unlocked automatically
    // since it only ever checked booking.status === COMPLETED.
    void sendBookingCompletionEmail(bookingId).catch((error) => {
      logError("COMPLETION_EMAIL_FAILED", { bookingId, error });
    });

    try {
      await ensureEarningForBooking(bookingId);
    } catch (error) {
      logError("EARNING_CREATION_FAILED", { bookingId, error });
    }

    await recordJobOutcome(professionalId, "COMPLETED");
  }

  const updated = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
  });

  return { booking: updated, alreadyInState: false as const };
};

//////////////////////////////////////////////////////
// CANCEL (professional backs out before work starts)
//////////////////////////////////////////////////////

export const cancelAssignedJob = async ({
  bookingId,
  professionalId,
  professionalUserId,
  reason,
}: {
  bookingId: string;
  professionalId: string;
  professionalUserId: string;
  reason?: string;
}) => {
  const booking = await loadOwnAssignedBooking(bookingId, professionalId);

  if (booking.status === BookingStatus.CANCELLED) {
    return { booking, alreadyCancelled: true as const };
  }

  if (booking.status === BookingStatus.COMPLETED) {
    throw new AppError(
      "Completed bookings cannot be cancelled.",
      409,
      "BOOKING_COMPLETED"
    );
  }

  if (!CANCELLABLE_FROM_STATUSES.includes(booking.status)) {
    throw new AppError(
      `Cannot cancel while the booking is ${booking.status}.`,
      409,
      "INVALID_JOB_TRANSITION"
    );
  }

  const trimmedReason =
    typeof reason === "string" ? reason.trim().slice(0, 500) : "";

  if (!trimmedReason) {
    throw new AppError(
      "A reason is required to cancel this job.",
      400,
      "REASON_REQUIRED"
    );
  }

  const claim = await prisma.booking.updateMany({
    where: {
      id: bookingId,
      assignedProfessionalId: professionalId,
      status: { in: CANCELLABLE_FROM_STATUSES },
    },
    data: { status: BookingStatus.CANCELLED },
  });

  if (claim.count === 0) {
    const fresh = await prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (fresh?.status === BookingStatus.CANCELLED) {
      return { booking: fresh, alreadyCancelled: true as const };
    }

    throw new AppError(
      "Cannot cancel — booking is no longer in a cancellable state.",
      409,
      "INVALID_JOB_TRANSITION"
    );
  }

  await prisma.bookingTimeline.create({
    data: {
      bookingId,
      status: BookingStatus.CANCELLED,
      message: `Cancelled by professional: ${trimmedReason}`,
      createdById: professionalUserId,
    },
  });

  log("CANCELLED_BY_PROFESSIONAL", { bookingId, professionalId });

  await recordJobOutcome(professionalId, "CANCELLED");

  try {
    await createNotification({
      userId: booking.userId,
      type: NotificationType.BOOKING_CANCELLED,
      title: `Booking cancelled (${booking.displayId ?? booking.id})`,
      message: `Your booking was cancelled by the assigned professional. Reason: ${trimmedReason}`,
      linkUrl: `/orders/${booking.id}`,
      data: { bookingId: booking.id },
    });
  } catch (error) {
    logError("CUSTOMER_NOTIFY_FAILED", { bookingId, error });
  }

  const updated = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
  });

  return { booking: updated, alreadyCancelled: false as const };
};
