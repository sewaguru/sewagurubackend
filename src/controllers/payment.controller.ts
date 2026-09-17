import { Request, Response } from "express";
import {
  PaymentStatus,
  Prisma,
} from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { AuthRequest } from "../types/types";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { config } from "../config/config";
import {
  buildMerchantOrderId,
  buildPaymentRedirectUrl,
  createStandardCheckoutOrder,
  fetchOrderStatusFromPhonePe,
  mapPhonePeStateToPaymentStatus,
  toPaise,
  validatePhonePeWebhook,
} from "../services/phonepe.service";
import { activateBookingAfterSuccessfulPayment } from "../services/bookingPlacement.service";
import { ensureEarningForBooking } from "../services/earnings.service";
import {
  canStartOnlinePayment,
  getPlatformPaymentSettings,
  isFreeBookingAmount,
} from "../services/platformSettings.service";
import { getAssignedBranchIds } from "../utils/branchScope.util";

const toErrorMessage = (
  error: unknown
) =>
  error instanceof Error
    ? error.message
    : "unknown error";

const paymentInfo = (
  event: string,
  data: Record<string, unknown>
) => {
  console.log(
    "[PAYMENT]",
    event,
    data
  );
};

const paymentWarn = (
  event: string,
  data: Record<string, unknown>
) => {
  console.warn(
    "[PAYMENT]",
    event,
    data
  );
};

const paymentError = (
  event: string,
  data: Record<string, unknown>
) => {
  console.error(
    "[PAYMENT]",
    event,
    data
  );
};

const toJsonValue = (
  value: unknown
): Prisma.InputJsonValue =>
  JSON.parse(
    JSON.stringify(value ?? null)
  ) as Prisma.InputJsonValue;

const assertAuthenticatedUser = (
  req: AuthRequest
) => {
  if (!req.user) {
    throw new AppError(
      "Unauthorized",
      401
    );
  }

  return req.user;
};

const buildClientPaymentStatusUrl = (
  bookingId: string
) => {
  const baseUrl = (
    config.CLIENT_URL || ""
  ).replace(/\/+$/, "");

  return `${baseUrl}/checkout/payment-status?bookingId=${encodeURIComponent(
    bookingId
  )}`;
};

type BookingWithPaymentContext =
  Prisma.BookingGetPayload<{
    include: {
      paymentOrders: {
        orderBy: {
          createdAt: "desc";
        };
      };
      user: {
        include: {
          profile: true;
          authMethods: {
            orderBy: {
              createdAt: "asc";
            };
          };
        };
      };
      items: {
        select: {
          quantity: true;
          serviceSnapshot: true;
          serviceNode: {
            select: {
              name: true;
            };
          };
        };
      };
    };
  }>;

const assertBookingAccess = async (
  req: AuthRequest,
  bookingId: string
): Promise<BookingWithPaymentContext> => {
  const authUser =
    assertAuthenticatedUser(req);

  const booking =
    await prisma.booking.findFirst({
      where: {
        id: bookingId,
        deletedAt: null,
      },
      include: {
        paymentOrders: {
          orderBy: {
            createdAt: "desc",
          },
        },
        user: {
          include: {
            profile: true,
            authMethods: {
              orderBy: {
                createdAt: "asc",
              },
            },
          },
        },
        items: {
          select: {
            quantity: true,
            serviceSnapshot: true,
            serviceNode: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

  if (!booking) {
    throw new AppError(
      "Booking not found",
      404
    );
  }

  if (
    booking.userId === authUser.id ||
    authUser.role === "SUPER_ADMIN"
  ) {
    return booking;
  }

  if (
    authUser.role === "ADMIN" ||
    authUser.role === "BRANCH_ADMIN"
  ) {
    const branchIds =
      await getAssignedBranchIds(
        authUser.id
      );

    if (
      branchIds.includes(
        booking.branchId
      )
    ) {
      return booking;
    }
  }

  throw new AppError("Forbidden", 403);
};

const getPaymentCustomer = (
  booking: BookingWithPaymentContext
) => {
  const emailAuth =
    booking.user.authMethods.find(
      (method) =>
        method.identifierType ===
          "EMAIL" &&
        method.isVerified
    ) ??
    booking.user.authMethods.find(
      (method) =>
        method.identifierType === "EMAIL"
    );

  const phoneAuth =
    booking.user.authMethods.find(
      (method) =>
        method.identifierType ===
          "PHONE" &&
        method.isVerified
    ) ??
    booking.user.authMethods.find(
      (method) =>
        method.identifierType === "PHONE"
    );

  return {
    firstName:
      booking.user.profile?.fullName ||
      "SewaGuru Customer",
    email:
      booking.user.profile?.email ||
      emailAuth?.identifier ||
      null,
    phone:
      phoneAuth?.identifier || null,
  };
};

const getBookingProductInfo = (
  booking: BookingWithPaymentContext
) => {
  const serviceNames = booking.items
    .map((item) => {
      const snapshot =
        item.serviceSnapshot;
      const snapshotName =
        snapshot &&
        typeof snapshot ===
          "object" &&
        "name" in snapshot &&
        typeof snapshot.name ===
          "string"
          ? snapshot.name
          : null;

      return (
        snapshotName ||
        item.serviceNode?.name ||
        "Service"
      );
    })
    .filter(Boolean);

  if (serviceNames.length === 0) {
    return `SewaGuru Booking ${
      booking.displayId || booking.id
    }`;
  }

  const preview = serviceNames
    .slice(0, 3)
    .join(", ");

  return serviceNames.length > 3
    ? `${preview} +${
        serviceNames.length - 3
      } more`
    : preview;
};

const createPhonePePaymentOrderForBooking =
  async (
    booking: BookingWithPaymentContext
  ) => {
    const merchantOrderId =
      buildMerchantOrderId(
        booking.id
      );

    const amount = toPaise(
      booking.totalAmount
    );

    const redirectUrl =
      buildPaymentRedirectUrl(
        booking.id
      );

    let request: unknown;
    let providerResponse: {
      orderId?: string;
      state?: string;
      redirectUrl?: string;
    };

    try {
      const created =
        await createStandardCheckoutOrder(
          {
            merchantOrderId,
            amount,
            redirectUrl,
          }
        );
      request = created.request;
      providerResponse =
        created.response;
    } catch (error) {
      paymentError(
        "PHONEPE_CREATE_ORDER_FAILED",
        {
          bookingId: booking.id,
          merchantOrderId,
          amount,
          message:
            toErrorMessage(error),
        }
      );
      throw error;
    }

    if (!providerResponse.orderId) {
      throw new AppError(
        "PhonePe did not return provider order id",
        502,
        "PHONEPE_INVALID_RESPONSE"
      );
    }

    if (!providerResponse.redirectUrl) {
      throw new AppError(
        "PhonePe did not return redirect url",
        502,
        "PHONEPE_INVALID_RESPONSE"
      );
    }

    const paymentOrder =
      await prisma.paymentOrder.create({
        data: {
          bookingId: booking.id,
          gateway: "PHONEPE",
          merchantOrderId,
          providerOrderId:
            providerResponse.orderId,
          state:
            providerResponse.state ??
            "PENDING",
          amount,
          rawRequest:
            toJsonValue(request),
          rawResponse:
            toJsonValue(
              providerResponse
            ),
        },
      });

    paymentInfo(
      "PHONEPE_ORDER_CREATED",
      {
        bookingId: booking.id,
        paymentOrderId:
          paymentOrder.id,
        merchantOrderId:
          paymentOrder.merchantOrderId,
        providerOrderId:
          paymentOrder.providerOrderId,
        amount: paymentOrder.amount,
      }
    );

    return {
      bookingId: booking.id,
      paymentOrderId:
        paymentOrder.id,
      paymentGateway: "PHONEPE" as const,
      merchantOrderId:
        paymentOrder.merchantOrderId,
      providerOrderId:
        paymentOrder.providerOrderId,
      state: paymentOrder.state,
      amount: paymentOrder.amount,
      redirectMethod: "GET" as const,
      redirectUrl:
        providerResponse.redirectUrl,
      redirectPayload: null,
    };
  };

const createGatewayOrder = async (
  _req: Request,
  booking: BookingWithPaymentContext
) =>
  createPhonePePaymentOrderForBooking(
    booking
  );

const getPaymentStatusUpdateData = (
  nextPaymentStatus: PaymentStatus,
  message: string
) => ({
  paymentStatus: nextPaymentStatus,
  timeline: {
    create: {
      paymentStatus:
        nextPaymentStatus,
      message,
    },
  },
});

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

  // No-op unless the booking was already COMPLETED before payment
  // confirmed (e.g. a delayed webhook arriving after job completion).
  try {
    await ensureEarningForBooking(bookingId);
  } catch (error) {
    paymentError("EARNING_CREATION_FAILED", {
      bookingId,
      message: toErrorMessage(error),
    });
  }
};

const syncPhonePeOrderStatus = async (
  booking: BookingWithPaymentContext,
  latestPaymentOrder: BookingWithPaymentContext["paymentOrders"][number]
) => {
  let paymentStatus: PaymentStatus =
    booking.paymentStatus;
  let providerState =
    latestPaymentOrder.state;
  let providerOrderId =
    latestPaymentOrder.providerOrderId;
  let synced = false;
  let syncError:
    | string
    | undefined;

  try {
    const providerStatus =
      await fetchOrderStatusFromPhonePe(
        latestPaymentOrder.merchantOrderId
      );

    synced = true;
    providerState =
      providerStatus.state ??
      providerState;
    providerOrderId =
      providerStatus.orderId ??
      providerOrderId;

    const nextPaymentStatus =
      mapPhonePeStateToPaymentStatus(
        providerState,
        paymentStatus
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
          paymentStatus
        ) {
          await tx.booking.update({
            where: {
              id: booking.id,
            },
            data: getPaymentStatusUpdateData(
              nextPaymentStatus,
              `Payment status synced from PhonePe: ${providerState}`
            ),
          });
        }
      }
    );

    paymentStatus =
      nextPaymentStatus;

    await ensureBookingVisibleAfterPaid(
      booking.id,
      nextPaymentStatus
    );
  } catch (error) {
    paymentWarn(
      "PHONEPE_STATUS_SYNC_FAILED",
      {
        bookingId: booking.id,
        paymentOrderId:
          latestPaymentOrder.id,
        merchantOrderId:
          latestPaymentOrder.merchantOrderId,
        message:
          toErrorMessage(error),
      }
    );
    syncError =
      error instanceof Error
        ? error.message
        : "Failed to sync with PhonePe";
  }

  return {
    paymentStatus,
    providerState,
    providerOrderId,
    synced,
    syncError,
  };
};

const createPaymentOrderHandler =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      assertAuthenticatedUser(req);

      const { bookingId } = req.body as {
        bookingId?: string;
      };

      if (!bookingId) {
        throw new AppError(
          "bookingId is required",
          400
        );
      }

      const booking =
        await assertBookingAccess(
          req,
          bookingId
        );

      if (
        booking.paymentStatus === "PAID"
      ) {
        throw new AppError(
          "Booking is already paid",
          400
        );
      }

      if (
        booking.paymentStatus ===
          "NOT_REQUIRED" ||
        isFreeBookingAmount(
          booking.totalAmount
        )
      ) {
        throw new AppError(
          "Payment is not required for this booking",
          400,
          "PAYMENT_NOT_REQUIRED"
        );
      }

      const paymentSettings =
        await getPlatformPaymentSettings();

      if (
        !canStartOnlinePayment(
          paymentSettings,
          booking.totalAmount
        )
      ) {
        throw new AppError(
          "Online payment is currently disabled",
          503,
          "PAYMENT_DISABLED"
        );
      }

      const gatewayStatus =
        paymentSettings.gatewayAvailability.PHONEPE;

      if (!gatewayStatus?.usable) {
        throw new AppError(
          "PhonePe payment is currently unavailable",
          503,
          "PAYMENT_GATEWAY_UNAVAILABLE"
        );
      }

      const order =
        await createGatewayOrder(
          req,
          booking
        );

      res.json(
        successResponse(
          order,
          "PhonePe payment order created"
        )
      );
    }
  );

export const createPaymentOrder =
  createPaymentOrderHandler;

export const createPhonePeOrder =
  createPaymentOrderHandler;

export const phonePeWebhook =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {
      const authorizationHeader =
        req.header(
          "authorization"
        ) ??
        req.header("x-verify") ??
        undefined;

      const rawBody = (
        req as Request & {
          rawBody?: string;
        }
      ).rawBody;

      const responseBody =
        typeof rawBody ===
          "string" &&
        rawBody.trim().length > 0
          ? rawBody
          : typeof req.body ===
            "string"
          ? req.body
          : JSON.stringify(
              req.body ?? {}
            );

      let callback: unknown;

      try {
        callback =
          validatePhonePeWebhook({
            authorizationHeader,
            responseBody,
          });
      } catch (error) {
        paymentWarn(
          "PHONEPE_WEBHOOK_VERIFY_FAILED",
          {
            message:
              toErrorMessage(error),
          }
        );
        throw error;
      }

      const payload =
        (
          callback as unknown as {
            payload?: Record<
              string,
              unknown
            >;
          }
        ).payload ?? {};

      const providerOrderId =
        typeof payload.orderId ===
        "string"
          ? payload.orderId
          : "";

      const merchantOrderId =
        typeof payload.merchantOrderId ===
        "string"
          ? payload.merchantOrderId
          : "";

      const providerState =
        typeof payload.state ===
        "string"
          ? payload.state
          : "PENDING";

      if (!providerOrderId) {
        paymentWarn(
          "PHONEPE_WEBHOOK_INVALID_PAYLOAD",
          {
            merchantOrderId,
            state: providerState,
          }
        );
        throw new AppError(
          "Invalid PhonePe webhook payload",
          400,
          "PHONEPE_INVALID_WEBHOOK"
        );
      }

      const paymentOrder =
        await prisma.paymentOrder.findFirst({
          where: {
            gateway: "PHONEPE",
            OR: [
              { providerOrderId },
              ...(merchantOrderId
                ? [
                    {
                      merchantOrderId,
                    },
                  ]
                : []),
            ],
          },
          include: {
            booking: true,
          },
        });

      if (!paymentOrder) {
        paymentWarn(
          "PHONEPE_WEBHOOK_UNKNOWN_ORDER",
          {
            providerOrderId,
            merchantOrderId,
            state: providerState,
          }
        );
        return res.json(
          successResponse(
            {
              received: true,
              ignored: true,
            },
            "Webhook acknowledged"
          )
        );
      }

      const nextPaymentStatus =
        mapPhonePeStateToPaymentStatus(
          providerState,
          paymentOrder.booking
            .paymentStatus
        );

      const isSameState =
        paymentOrder.state ===
        providerState;
      const isSamePaymentStatus =
        paymentOrder.booking
          .paymentStatus ===
        nextPaymentStatus;

      if (
        isSameState &&
        isSamePaymentStatus
      ) {
        await ensureBookingVisibleAfterPaid(
          paymentOrder.bookingId,
          nextPaymentStatus
        );

        return res.json(
          successResponse(
            {
              received: true,
              idempotent: true,
            },
            "Webhook already processed"
          )
        );
      }

      await prisma.$transaction(
        async (tx) => {
          await tx.paymentOrder.update({
            where: {
              id: paymentOrder.id,
            },
            data: {
              providerOrderId,
              state: providerState,
              rawResponse:
                toJsonValue(
                  req.body ?? {}
                ),
            },
          });

          if (
            !isSamePaymentStatus
          ) {
            await tx.booking.update({
              where: {
                id: paymentOrder.bookingId,
              },
              data: getPaymentStatusUpdateData(
                nextPaymentStatus,
                `Payment status updated via PhonePe webhook: ${providerState}`
              ),
            });
          }
        }
      );

      await ensureBookingVisibleAfterPaid(
        paymentOrder.bookingId,
        nextPaymentStatus
      );

      paymentInfo(
        "PHONEPE_WEBHOOK_PROCESSED",
        {
          bookingId:
            paymentOrder.bookingId,
          paymentOrderId:
            paymentOrder.id,
          providerOrderId,
          merchantOrderId:
            paymentOrder.merchantOrderId,
          state: providerState,
          paymentStatus:
            nextPaymentStatus,
        }
      );

      res.json(
        successResponse(
          {
            received: true,
            processed: true,
          },
          "Webhook processed"
        )
      );
    }
  );


const getPaymentStatusHandler = (
  syncGateway: boolean
) =>
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const bookingId =
        getParam(
          req.params.bookingId,
          "bookingId"
        );

      const booking =
        await assertBookingAccess(
          req,
          bookingId
        );

      const latestPaymentOrder =
        booking.paymentOrders[0];

      if (
        booking.paymentStatus ===
          "NOT_REQUIRED" ||
        isFreeBookingAmount(
          booking.totalAmount
        )
      ) {
        return res.json(
          successResponse(
            {
              bookingId: booking.id,
              bookingStatus:
                booking.status,
              orderPlaced:
                booking.isActive,
              paymentStatus:
                "NOT_REQUIRED",
              synced: true,
              paymentGateway: null,
              providerOrderId: null,
              merchantOrderId: null,
              providerState: null,
              amount: 0,
            },
            "Payment not required"
          )
        );
      }

      if (!latestPaymentOrder) {
        return res.json(
          successResponse(
            {
              bookingId: booking.id,
              bookingStatus:
                booking.status,
              orderPlaced:
                booking.isActive,
              paymentStatus:
                booking.paymentStatus,
              synced: false,
              paymentGateway: null,
              providerOrderId: null,
              merchantOrderId: null,
              providerState: null,
            },
            "No payment order found"
          )
        );
      }

      let result: {
        paymentStatus: PaymentStatus;
        providerState: string;
        providerOrderId: string | null;
        synced: boolean;
        syncError: string | undefined;
      } = {
        paymentStatus:
          booking.paymentStatus,
        providerState:
          latestPaymentOrder.state,
        providerOrderId:
          latestPaymentOrder.providerOrderId,
        synced: false,
        syncError: undefined as
          | string
          | undefined,
      };

      if (syncGateway) {
        result =
          await syncPhonePeOrderStatus(
            booking,
            latestPaymentOrder
          );
      }

      res.json(
        successResponse(
          {
            bookingId: booking.id,
            bookingStatus:
              booking.status,
            orderPlaced:
              booking.isActive ||
              result.paymentStatus ===
                "PAID",
            paymentStatus:
              result.paymentStatus,
            synced:
              result.synced,
            syncError:
              result.syncError,
            paymentGateway:
              latestPaymentOrder.gateway,
            providerOrderId:
              result.providerOrderId,
            merchantOrderId:
              latestPaymentOrder.merchantOrderId,
            providerState:
              result.providerState,
            amount:
              latestPaymentOrder.amount,
          },
          "Payment status fetched"
        )
      );
    }
  );

export const getPaymentOrderStatus =
  getPaymentStatusHandler(true);

export const getPhonePeOrderStatus =
  getPaymentStatusHandler(true);
