import { Response } from "express";
import { AuthRequest } from "../types/types";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";
import {
  getPlatformPaymentSettings,
  updatePlatformPaymentSettings,
  getPlatformCommissionPercent,
  updatePlatformCommissionPercent,
} from "../services/platformSettings.service";
import {
  getAdminEmailManagementSettings,
  updateAdminEmailManagementSettings,
} from "../services/emailManagement.service";

const parseBooleanField = (
  value: unknown,
  field: string
) => {
  if (typeof value !== "boolean") {
    throw new AppError(
      `${field} must be a boolean`,
      400
    );
  }

  return value;
};

export const getPublicPaymentSettings =
  catchAsync(
    async (
      _req: AuthRequest,
      res: Response
    ) => {
      const settings =
        await getPlatformPaymentSettings();

      res.json(
        successResponse(
          settings,
          "Payment settings fetched"
        )
      );
    }
  );

export const getAdminPaymentSettings =
  catchAsync(
    async (
      _req: AuthRequest,
      res: Response
    ) => {
      const settings =
        await getPlatformPaymentSettings();

      res.json(
        successResponse(
          settings,
          "Admin payment settings fetched"
        )
      );
    }
  );

export const updateAdminPaymentSettings =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const {
        paymentEnabled,
        allowPayLater,
        phonePeFeatureEnabled,
      } = req.body as {
        paymentEnabled?: unknown;
        allowPayLater?: unknown;
        phonePeFeatureEnabled?: unknown;
      };

      if (
        typeof paymentEnabled !==
        "boolean"
      ) {
        throw new AppError(
          "paymentEnabled must be a boolean",
          400
        );
      }

      if (
        typeof allowPayLater !==
        "boolean"
      ) {
        throw new AppError(
          "allowPayLater must be a boolean",
          400
        );
      }

      const settings =
        await updatePlatformPaymentSettings(
          {
            paymentEnabled,
            allowPayLater,
            phonePeFeatureEnabled:
              parseBooleanField(
                phonePeFeatureEnabled,
                "phonePeFeatureEnabled"
              ),
          }
        );

      res.json(
        successResponse(
          settings,
          "Payment settings updated"
        )
      );
    }
  );

export const getAdminCommissionSettings =
  catchAsync(
    async (
      _req: AuthRequest,
      res: Response
    ) => {
      const platformCommissionPercent =
        await getPlatformCommissionPercent();

      res.json(
        successResponse(
          { platformCommissionPercent },
          "Commission settings fetched"
        )
      );
    }
  );

export const updateAdminCommissionSettings =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const { platformCommissionPercent } =
        req.body as {
          platformCommissionPercent?: unknown;
        };

      const percent = Number(
        platformCommissionPercent
      );

      if (
        !Number.isFinite(percent) ||
        percent < 0 ||
        percent > 100
      ) {
        throw new AppError(
          "platformCommissionPercent must be a number between 0 and 100",
          400
        );
      }

      const updated =
        await updatePlatformCommissionPercent(
          percent
        );

      res.json(
        successResponse(
          {
            platformCommissionPercent:
              updated,
          },
          "Commission settings updated"
        )
      );
    }
  );

export const getAdminEmailSettings =
  catchAsync(
    async (
      _req: AuthRequest,
      res: Response
    ) => {
      const settings =
        await getAdminEmailManagementSettings();

      res.json(
        successResponse(
          settings,
          "Email settings fetched"
        )
      );
    }
  );

export const updateAdminEmailSettings =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const {
        notificationsEnabled,
        welcomeEmailEnabled,
        welcomeCouponsEnabled,
        bookingConfirmationEmailEnabled,
        bookingCompletionEmailEnabled,
        paymentConfirmationEmailEnabled,
        welcomeCouponCodes,
        templates,
      } = req.body as {
        notificationsEnabled?: unknown;
        welcomeEmailEnabled?: unknown;
        welcomeCouponsEnabled?: unknown;
        bookingConfirmationEmailEnabled?: unknown;
        bookingCompletionEmailEnabled?: unknown;
        paymentConfirmationEmailEnabled?: unknown;
        welcomeCouponCodes?: unknown;
        templates?: unknown;
      };

      const settings =
        await updateAdminEmailManagementSettings(
          {
            notificationsEnabled:
              parseBooleanField(
                notificationsEnabled,
                "notificationsEnabled"
              ),
            welcomeEmailEnabled:
              parseBooleanField(
                welcomeEmailEnabled,
                "welcomeEmailEnabled"
              ),
            welcomeCouponsEnabled:
              parseBooleanField(
                welcomeCouponsEnabled,
                "welcomeCouponsEnabled"
              ),
            bookingConfirmationEmailEnabled:
              parseBooleanField(
                bookingConfirmationEmailEnabled,
                "bookingConfirmationEmailEnabled"
              ),
            bookingCompletionEmailEnabled:
              parseBooleanField(
                bookingCompletionEmailEnabled,
                "bookingCompletionEmailEnabled"
              ),
            paymentConfirmationEmailEnabled:
              parseBooleanField(
                paymentConfirmationEmailEnabled,
                "paymentConfirmationEmailEnabled"
              ),
            welcomeCouponCodes:
              welcomeCouponCodes ?? [],
            templates,
          }
        );

      res.json(
        successResponse(
          settings,
          "Email settings updated"
        )
      );
    }
  );
