import { NotificationType } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import {
  sendBookingAdminAlertEmail,
  sendBookingConfirmationEmail,
  sendPaymentConfirmationEmail,
} from "./emailManagement.service";
import {
  createNotification,
  notifyBranchAdmins,
} from "./notification.service";
import {
  getBookingItemNames,
  hydrateBookingForResponse,
} from "../utils/bookingSnapshot";
import { triggerDispatchForBooking } from "./dispatch.service";

const BOOKING_CREATE_NOTIFICATION_SELECT = {
  id: true,
  displayId: true,
  userId: true,
  branchId: true,
  status: true,
  paymentStatus: true,
  isActive: true,
  deletedAt: true,
  items: {
    include: {
      serviceNode: {
        select: {
          name: true,
        },
      },
    },
  },
} as const;

const notifyBookingPlaced = async (
  bookingId: string
) => {
  const booking =
    await prisma.booking.findUnique({
      where: { id: bookingId },
      select:
        BOOKING_CREATE_NOTIFICATION_SELECT,
    });

  if (
    !booking ||
    !booking.isActive ||
    booking.deletedAt
  ) {
    return;
  }

  const bookingPayload =
    hydrateBookingForResponse(booking);
  const bookingRef =
    booking.displayId ?? booking.id;
  const serviceNames =
    getBookingItemNames(
      bookingPayload.items
    );

  try {
    await Promise.all([
      createNotification({
        userId: booking.userId,
        type:
          NotificationType.BOOKING_CREATED,
        title: `Booking created (${bookingRef})`,
        message: `Your booking for ${serviceNames} has been created.`,
        linkUrl: `/orders/${booking.id}`,
        data: {
          bookingId: booking.id,
          displayId:
            booking.displayId ?? null,
        },
      }),
      notifyBranchAdmins(
        booking.branchId,
        {
          type:
            NotificationType.BOOKING_CREATED,
          title: `New booking (${bookingRef})`,
          message: `New booking created for ${serviceNames}.`,
          linkUrl: `/dashboard/bookings/${booking.id}`,
          data: {
            bookingId: booking.id,
            displayId:
              booking.displayId ?? null,
          },
        }
      ),
    ]);
  } catch (error) {
    console.error(
      "[NOTIFY] Failed to create booking placement notifications",
      {
        bookingId: booking.id,
        error,
      }
    );
  }

  void sendBookingConfirmationEmail(
    booking.id
  ).catch((error) => {
    console.error(
      "[EMAIL] Failed to send booking confirmation email",
      {
        bookingId: booking.id,
        error,
      }
    );
  });

  void sendBookingAdminAlertEmail(
    booking.id
  ).catch((error) => {
    console.error(
      "[EMAIL] Failed to send admin alert email",
      {
        bookingId: booking.id,
        error,
      }
    );
  });

  // Fire-and-forget: dispatch failures must never affect the booking
  // response. triggerDispatchForBooking is itself idempotent (guarded by
  // Booking.dispatchStatus), so this is safe even if notifyBookingPlaced
  // is ever invoked more than once for the same booking.
  void triggerDispatchForBooking(booking.id).catch((error) => {
    console.error(
      "[DISPATCH] Failed to trigger dispatch",
      {
        bookingId: booking.id,
        error,
      }
    );
  });
};

export const dispatchBookingPlacedSideEffects =
  notifyBookingPlaced;

export const activateBookingAfterSuccessfulPayment =
  async (bookingId: string) => {
    const booking =
      await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          isActive: true,
          deletedAt: true,
          status: true,
          paymentStatus: true,
        },
      });

    if (
      !booking ||
      booking.deletedAt
    ) {
      return {
        activated: false,
      };
    }

    if (booking.isActive) {
      return {
        activated: false,
      };
    }

    await prisma.booking.update({
      where: {
        id: booking.id,
      },
      data: {
        isActive: true,
        timeline: {
          create: {
            status: booking.status,
            paymentStatus:
              booking.paymentStatus,
            message:
              "Online payment received. Your order is now placed successfully.",
          },
        },
      },
    });

    await notifyBookingPlaced(
      booking.id
    );

    void sendPaymentConfirmationEmail(
      booking.id
    ).catch((error) => {
      console.error(
        "[EMAIL] Failed to send payment confirmation email",
        {
          bookingId: booking.id,
          error,
        }
      );
    });

    return {
      activated: true,
    };
  };
