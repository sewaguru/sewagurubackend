import { randomUUID } from "crypto";
import {
  Env,
  StandardCheckoutClient,
  StandardCheckoutPayRequest,
} from "pg-sdk-node";
import { PaymentStatus } from "../generated/prisma";
import { config } from "../config/config";
import { AppError } from "../utils/AppError";

let cachedPhonePeClient:
  | StandardCheckoutClient
  | null = null;

const sanitizeBaseUrl = (
  url: string
) => url.replace(/\/+$/, "");

export const assertPhonePeReady =
  () => {
    if (!config.PHONEPE_ENABLED) {
      throw new AppError(
        "PhonePe payment is disabled",
        503,
        "PHONEPE_DISABLED"
      );
    }

    if (
      !config.PHONEPE_CREDENTIALS_READY
    ) {
      throw new AppError(
        "PhonePe credentials are not configured",
        500,
        "PHONEPE_NOT_CONFIGURED"
      );
    }
  };

const getPhonePeClient = () => {
  assertPhonePeReady();

  if (!cachedPhonePeClient) {
    cachedPhonePeClient =
      StandardCheckoutClient.getInstance(
        config.PHONEPE_CLIENT_ID,
        config.PHONEPE_CLIENT_SECRET,
        config.PHONEPE_CLIENT_VERSION,
        config.PHONEPE_ENV ===
          "PRODUCTION"
          ? Env.PRODUCTION
          : Env.SANDBOX
      );
  }

  return cachedPhonePeClient;
};

export const buildMerchantOrderId = (
  bookingId: string
) => {
  const bookingPart = bookingId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-12);
  const nonce = randomUUID()
    .replace(/-/g, "")
    .slice(0, 8);

  return `SG${Date.now()}${bookingPart}${nonce}`;
};

export const buildPaymentRedirectUrl = (
  bookingId: string
) => {
  const base = sanitizeBaseUrl(
    config.PHONEPE_REDIRECT_BASE_URL
  );

  return `${base}/checkout/payment-status?bookingId=${encodeURIComponent(
    bookingId
  )}`;
};

export const toPaise = (
  amountRupees: number
) => {
  const amountPaise = Math.round(
    amountRupees * 100
  );

  if (!Number.isFinite(amountPaise)) {
    throw new AppError(
      "Invalid booking amount",
      400,
      "INVALID_PAYMENT_AMOUNT"
    );
  }

  if (amountPaise <= 0) {
    throw new AppError(
      "Booking amount must be greater than zero",
      400,
      "INVALID_PAYMENT_AMOUNT"
    );
  }

  return amountPaise;
};

export const createStandardCheckoutOrder =
  async (params: {
    merchantOrderId: string;
    amount: number;
    redirectUrl: string;
  }) => {
    const client = getPhonePeClient();

    const request =
      StandardCheckoutPayRequest.builder()
        .merchantOrderId(
          params.merchantOrderId
        )
        .amount(params.amount)
        .redirectUrl(params.redirectUrl)
        .build();

    try {
      const response = await client.pay(
        request
      );

      if (!response?.orderId) {
        throw new AppError(
          "PhonePe did not return provider order id",
          502,
          "PHONEPE_INVALID_RESPONSE"
        );
      }

      if (!response?.redirectUrl) {
        throw new AppError(
          "PhonePe did not return redirect url",
          502,
          "PHONEPE_INVALID_RESPONSE"
        );
      }

      return {
        request,
        response,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Failed to create PhonePe order",
        502,
        "PHONEPE_CREATE_ORDER_FAILED"
      );
    }
  };

export const fetchOrderStatusFromPhonePe =
  async (merchantOrderId: string) => {
    const client = getPhonePeClient();

    try {
      return await client.getOrderStatus(
        merchantOrderId,
        true
      );
    } catch {
      throw new AppError(
        "Failed to fetch PhonePe order status",
        502,
        "PHONEPE_STATUS_FETCH_FAILED"
      );
    }
  };

export const validatePhonePeWebhook =
  (params: {
    authorizationHeader:
      | string
      | undefined;
    responseBody: string;
  }) => {
    const client = getPhonePeClient();

    const header =
      params.authorizationHeader?.trim();

    if (!header) {
      throw new AppError(
        "Missing PhonePe authorization header",
        401,
        "PHONEPE_INVALID_WEBHOOK"
      );
    }

    const authorization = header.replace(
      /^bearer\s+/i,
      ""
    );

    try {
      return client.validateCallback(
        config.PHONEPE_CALLBACK_USERNAME,
        config.PHONEPE_CALLBACK_PASSWORD,
        authorization,
        params.responseBody
      );
    } catch {
      throw new AppError(
        "Invalid PhonePe webhook signature",
        401,
        "PHONEPE_INVALID_WEBHOOK"
      );
    }
  };

export const mapPhonePeStateToPaymentStatus =
  (
    phonePeState: string,
    current: PaymentStatus
  ): PaymentStatus => {
    const normalized = phonePeState
      .trim()
      .toUpperCase();

    let next: PaymentStatus = "PENDING";

    if (
      normalized.includes("COMPLETED") ||
      normalized === "SUCCESS"
    ) {
      next = "PAID";
    } else if (
      normalized.includes("FAILED") ||
      normalized.includes("FAILURE") ||
      normalized.includes("DECLINED") ||
      normalized.includes("CANCELLED")
    ) {
      next = "FAILED";
    }

    // Never downgrade a completed payment.
    if (
      current === "PAID" &&
      next !== "PAID"
    ) {
      return "PAID";
    }

    return next;
  };

export const isTerminalPaymentStatus = (
  status: PaymentStatus
) =>
  status === "PAID" ||
  status === "FAILED" ||
  status === "REFUNDED";
