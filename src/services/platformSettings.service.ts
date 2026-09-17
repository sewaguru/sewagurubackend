import {
  BookingStatus,
  PaymentStatus,
  PlatformSetting,
} from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { config } from "../config/config";

const PLATFORM_SETTING_KEY =
  "default";

type PlatformSettingRecord =
  Pick<
    PlatformSetting,
    | "paymentEnabled"
    | "allowPayLater"
    | "activePaymentGateway"
    | "phonePeFeatureEnabled"
    | "updatedAt"
  >;

type GatewayAvailability = {
  PHONEPE: {
    featureEnabled: boolean;
    credentialsReady: boolean;
    usable: boolean;
  };
};

export type PlatformPaymentSettings =
  {
    paymentEnabled: boolean;
    allowPayLater: boolean;
    activePaymentGateway: "PHONEPE";
    phonePeFeatureEnabled: boolean;
    paymentProviderReady: boolean;
    paymentFlowEnabled: boolean;
    gatewayAvailability: GatewayAvailability;
    source: "DATABASE" | "ENV_DEFAULTS";
    updatedAt: string | null;
  };

const buildGatewayAvailability = (
  record?: PlatformSettingRecord | null
): GatewayAvailability => {
  const phonePeFeatureEnabled =
    record?.phonePeFeatureEnabled ?? true;

  return {
    PHONEPE: {
      featureEnabled:
        phonePeFeatureEnabled,
      credentialsReady:
        config.PHONEPE_CREDENTIALS_READY,
      usable:
        phonePeFeatureEnabled &&
        config.PHONEPE_ENABLED &&
        config.PHONEPE_CREDENTIALS_READY,
    },
  };
};

const toPlatformPaymentSettings = (
  record?: PlatformSettingRecord | null
): PlatformPaymentSettings => {
  const paymentEnabled =
    record?.paymentEnabled ??
    config.PAYMENT_ENABLED;
  const allowPayLater =
    record?.allowPayLater ??
    config.ALLOW_PAY_LATER;
  const gatewayAvailability =
    buildGatewayAvailability(record);
  const paymentProviderReady =
    gatewayAvailability.PHONEPE.usable;

  return {
    paymentEnabled,
    allowPayLater,
    activePaymentGateway: "PHONEPE",
    phonePeFeatureEnabled:
      gatewayAvailability.PHONEPE
        .featureEnabled,
    paymentProviderReady,
    paymentFlowEnabled:
      paymentEnabled &&
      paymentProviderReady,
    gatewayAvailability,
    source: record
      ? "DATABASE"
      : "ENV_DEFAULTS",
    updatedAt:
      record?.updatedAt?.toISOString() ??
      null,
  };
};

export const getPlatformPaymentSettings =
  async () => {
    const record =
      await prisma.platformSetting.findUnique(
        {
          where: {
            key: PLATFORM_SETTING_KEY,
          },
          select: {
            paymentEnabled: true,
            allowPayLater: true,
            activePaymentGateway: true,
            phonePeFeatureEnabled: true,
            updatedAt: true,
          },
        }
      );

    return toPlatformPaymentSettings(
      record
    );
  };

export const updatePlatformPaymentSettings =
  async (input: {
    paymentEnabled: boolean;
    allowPayLater: boolean;
    phonePeFeatureEnabled: boolean;
  }) => {
    const record =
      await prisma.platformSetting.upsert({
        where: {
          key: PLATFORM_SETTING_KEY,
        },
        create: {
          key: PLATFORM_SETTING_KEY,
          paymentEnabled:
            input.paymentEnabled,
          allowPayLater:
            input.allowPayLater,
          activePaymentGateway: "PHONEPE",
          phonePeFeatureEnabled:
            input.phonePeFeatureEnabled,
        },
        update: {
          paymentEnabled:
            input.paymentEnabled,
          allowPayLater:
            input.allowPayLater,
          activePaymentGateway: "PHONEPE",
          phonePeFeatureEnabled:
            input.phonePeFeatureEnabled,
        },
        select: {
          paymentEnabled: true,
          allowPayLater: true,
          activePaymentGateway: true,
          phonePeFeatureEnabled: true,
          updatedAt: true,
        },
      });

    return toPlatformPaymentSettings(
      record
    );
  };

export const isFreeBookingAmount = (
  totalAmount: unknown
) => {
  const parsed =
    typeof totalAmount === "number"
      ? totalAmount
      : Number(totalAmount);

  return (
    !Number.isFinite(parsed) ||
    parsed <= 0
  );
};

export const getInitialBookingStatus =
  (): BookingStatus => "CREATED";

export const getInitialPaymentStatus =
  (
    totalAmount: unknown
  ): PaymentStatus =>
    isFreeBookingAmount(totalAmount)
      ? "NOT_REQUIRED"
      : "PENDING";

export const canStartOnlinePayment = (
  settings: PlatformPaymentSettings,
  totalAmount: unknown
) =>
  settings.paymentFlowEnabled &&
  !isFreeBookingAmount(totalAmount);

export const getActivePaymentGateway =
  (
    _settings: PlatformPaymentSettings
  ): "PHONEPE" => "PHONEPE";

//////////////////////////////////////////////////////
// COMMISSION (professional earnings)
//////////////////////////////////////////////////////
// One global, admin-configurable percentage — deliberately not a
// per-branch/per-service override table. The existing project has no
// requirement for that granularity, and adding it now would be exactly
// the kind of premature complexity the brief asks to avoid.

const DEFAULT_COMMISSION_PERCENT = 20;

export const getPlatformCommissionPercent =
  async (): Promise<number> => {
    const record =
      await prisma.platformSetting.findUnique({
        where: {
          key: PLATFORM_SETTING_KEY,
        },
        select: {
          platformCommissionPercent: true,
        },
      });

    return (
      record?.platformCommissionPercent ??
      DEFAULT_COMMISSION_PERCENT
    );
  };

// Range validation is the caller's responsibility (matches this file's
// existing convention — see updateAdminPaymentSettings's controller-side
// checks — so every settings write path validates the same way).
export const updatePlatformCommissionPercent =
  async (
    percent: number
  ): Promise<number> => {
    const record =
      await prisma.platformSetting.upsert({
        where: {
          key: PLATFORM_SETTING_KEY,
        },
        create: {
          key: PLATFORM_SETTING_KEY,
          platformCommissionPercent: percent,
        },
        update: {
          platformCommissionPercent: percent,
        },
        select: {
          platformCommissionPercent: true,
        },
      });

    return record.platformCommissionPercent;
  };
