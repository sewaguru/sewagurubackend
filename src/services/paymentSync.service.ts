import {
  PaymentStatus,
  Prisma,
} from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { activateBookingAfterSuccessfulPayment } from "./bookingPlacement.service";
import { ensureEarningForBooking } from "./earnings.service";
import {
  fetchOrderStatusFromPhonePe,
  mapPhonePeStateToPaymentStatus,
} from "./phonepe.service";

const RECENT_PAYMENT_SYNC_WINDOW_MS =
  1000 * 60 * 60 * 24;

const toJsonValue = (
  value: unknown
): Prisma.InputJsonValue =>
  JSON.parse(
    JSON.stringify(value ?? null)
  ) as Prisma.InputJsonValue;

type SyncableBooking =
  Prisma.BookingGetPayload<{
    include: {
      paymentOrders: {
        orderBy: {
          createdAt: "desc";
        };
      };
    };
  }>;

const shouldAttemptProviderSync = (
  booking: SyncableBooking
) => {
  const latestPaymentOrder =
    booking.paymentOrders[0];

  if (!latestPaymentOrder) {
    return false;
  }

  if (booking.deletedAt) {
    return false;
  }

  if (
    booking.paymentStatus ===
      PaymentStatus.NOT_REQUIRED ||
    booking.paymentStatus ===
      PaymentStatus.REFUNDED
  ) {
    return false;
  }

  const needsVisibilityRepair =
    !booking.isActive;

  const needsPaymentRefresh =
    booking.paymentStatus ===
      PaymentStatus.PENDING ||
    booking.paymentStatus ===
      PaymentStatus.FAILED;

  if (
    !needsVisibilityRepair &&
    !needsPaymentRefresh
  ) {
    return false;
  }

  const lastTouchedAt = new Date(
    latestPaymentOrder.updatedAt ??
      latestPaymentOrder.createdAt
  ).getTime();

  return (
    Number.isFinite(lastTouchedAt) &&
    Date.now() - lastTouchedAt <=
      RECENT_PAYMENT_SYNC_WINDOW_MS
  );
};

const ensureBookingVisibleAfterPaid = async (
  bookingId: string,
  paymentStatus: PaymentStatus
) => {
  if (paymentStatus !== "PAID") {
    return;
  }

  await activateBookingAfterSuccessfulPayment(
    bookingId
  );

  // No-op unless the booking was already COMPLETED before this lazy sync
  // caught up with the gateway.
  try {
    await ensureEarningForBooking(bookingId);
  } catch (error) {
    console.warn(
      "[PAYMENT] EARNING_CREATION_FAILED",
      {
        bookingId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      }
    );
  }
};

const syncPhonePePaymentOrder = async (
  booking: SyncableBooking,
  latestPaymentOrder: SyncableBooking["paymentOrders"][number]
) => {
  const providerStatus =
    await fetchOrderStatusFromPhonePe(
      latestPaymentOrder.merchantOrderId
    );

  const providerState =
    providerStatus.state ??
    latestPaymentOrder.state;
  const providerOrderId =
    providerStatus.orderId ??
    latestPaymentOrder.providerOrderId;
  const nextPaymentStatus =
    mapPhonePeStateToPaymentStatus(
      providerState,
      booking.paymentStatus
    );

  await prisma.$transaction(
    async (tx) => {
      await tx.paymentOrder.update({
        where: {
          id: latestPaymentOrder.id,
        },
        data: {
          providerOrderId,
          state: providerState,
          rawResponse:
            toJsonValue(
              providerStatus
            ),
        },
      });

      if (
        nextPaymentStatus !==
        booking.paymentStatus
      ) {
        await tx.booking.update({
          where: {
            id: booking.id,
          },
          data: {
            paymentStatus:
              nextPaymentStatus,
            timeline: {
              create: {
                paymentStatus:
                  nextPaymentStatus,
                message: `Payment status synced from PhonePe: ${providerState}`,
              },
            },
          },
        });
      }
    }
  );

  await ensureBookingVisibleAfterPaid(
    booking.id,
    nextPaymentStatus
  );

  return nextPaymentStatus;
};

export const syncBookingPaymentStateIfNeeded =
  async (bookingId: string) => {
    const booking =
      await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          paymentOrders: {
            orderBy: {
              createdAt: "desc",
            },
          },
        },
      });

    if (!booking || booking.deletedAt) {
      return {
        bookingId,
        synced: false,
      };
    }

    if (
      booking.paymentStatus ===
        PaymentStatus.PAID &&
      !booking.isActive
    ) {
      await ensureBookingVisibleAfterPaid(
        booking.id,
        booking.paymentStatus
      );

      return {
        bookingId,
        synced: true,
        paymentStatus:
          booking.paymentStatus,
      };
    }

    if (
      !shouldAttemptProviderSync(booking)
    ) {
      return {
        bookingId,
        synced: false,
        paymentStatus:
          booking.paymentStatus,
      };
    }

    const latestPaymentOrder =
      booking.paymentOrders[0];

    if (!latestPaymentOrder) {
      return {
        bookingId,
        synced: false,
        paymentStatus:
          booking.paymentStatus,
      };
    }

    try {
      const nextPaymentStatus =
        await syncPhonePePaymentOrder(
          booking,
          latestPaymentOrder
        );

      return {
        bookingId,
        synced: true,
        paymentStatus:
          nextPaymentStatus,
      };
    } catch (error) {
      console.warn(
        "[PAYMENT] BOOKING_READ_SYNC_FAILED",
        {
          bookingId: booking.id,
          gateway:
            latestPaymentOrder.gateway,
          merchantOrderId:
            latestPaymentOrder.merchantOrderId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown error",
        }
      );

      return {
        bookingId,
        synced: false,
        paymentStatus:
          booking.paymentStatus,
      };
    }
  };

export const syncBookingPaymentsIfNeeded =
  async (bookingIds: string[]) => {
    const uniqueBookingIds = Array.from(
      new Set(
        bookingIds.filter(
          (bookingId) =>
            typeof bookingId ===
              "string" &&
            bookingId.trim().length > 0
        )
      )
    );

    await Promise.allSettled(
      uniqueBookingIds.map((bookingId) =>
        syncBookingPaymentStateIfNeeded(
          bookingId
        )
      )
    );
  };
