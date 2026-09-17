import { Response } from "express";
import { prisma } from "../lib/prisma";
import { sendPushToTokensDetailed } from "../services/push.service";
import { AuthRequest } from "../types/types";
import { AppError } from "../utils/AppError";
import { catchAsync } from "../utils/catchAsync";
import {
  getFcmRegistrationTokenValidationError,
} from "../utils/fcm-token.util";
import { successResponse } from "../utils/response.util";

const parseOptionalString = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeDeepLinkPath = (value: unknown) => {
  const normalized = parseOptionalString(value);
  if (!normalized) {
    return null;
  }

  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("sewaguru://")
  ) {
    return normalized;
  }

  return normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
};

const parseStringData = (value: unknown) => {
  if (value == null || value === "") {
    return {};
  }

  const normalized =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            throw new AppError(
              "data must be valid JSON.",
              400,
            );
          }
        })()
      : value;

  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized)
  ) {
    throw new AppError(
      "data must be a JSON object.",
      400,
    );
  }

  return Object.entries(
    normalized as Record<string, unknown>,
  ).reduce<Record<string, string>>(
    (accumulator, [key, entry]) => {
      if (entry == null) {
        return accumulator;
      }

      accumulator[key] =
        typeof entry === "string"
          ? entry
          : JSON.stringify(entry);
      return accumulator;
    },
    {},
  );
};

export const sendTestPushNotification =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response,
    ) => {
      if (!req.user) {
        throw new AppError("Unauthorized", 401);
      }

      const token = parseOptionalString(
        req.body.token,
      );
      const userId = parseOptionalString(
        req.body.userId,
      );
      const title =
        parseOptionalString(req.body.title) ??
        "SewaGuru test notification";
      const body =
        parseOptionalString(req.body.body) ??
        "This is a delivery test from the admin dashboard.";
      const deepLinkPath = normalizeDeepLinkPath(
        req.body.deepLinkPath,
      );
      const imageUrl = parseOptionalString(
        req.body.imageUrl,
      );
      const data = parseStringData(req.body.data);

      if (!token && !userId) {
        throw new AppError(
          "Provide either a device token or a userId for the test send.",
          400,
        );
      }

      if (token) {
        const tokenValidationError =
          getFcmRegistrationTokenValidationError(
            token,
          );

        if (tokenValidationError) {
          throw new AppError(
            tokenValidationError,
            400,
            "INVALID_FCM_TOKEN",
          );
        }
      }

      const userTokens = userId
        ? await prisma.deviceToken.findMany({
            where: {
              userId,
            },
            select: {
              token: true,
            },
          })
        : [];

      const tokens = [
        ...(token ? [token] : []),
        ...userTokens.map((row) => row.token),
      ];

      if (!tokens.length) {
        throw new AppError(
          "No device tokens were found for that test target.",
          404,
        );
      }

      console.info(
        "[Push] Test notification requested.",
        {
          requestedByUserId: req.user.id,
          targetUserId: userId,
          explicitTokenProvided: Boolean(token),
          resolvedTokenCount: tokens.length,
          deepLinkPath,
        },
      );

      const result =
        await sendPushToTokensDetailed(tokens, {
          title,
          body,
          data: {
            ...data,
            source: "dashboard_test",
            sentAt: new Date().toISOString(),
            ...(deepLinkPath
              ? {
                  linkUrl: deepLinkPath,
                }
              : {}),
          },
          ...(imageUrl
            ? {
                imageUrl,
              }
            : {}),
        });

      console.info(
        "[Push] Test notification completed.",
        {
          requestedByUserId: req.user.id,
          targetUserId: userId,
          requestedTokenCount:
            result.requestedTokenCount,
          deliveredDeviceCount:
            result.deliveredDeviceCount,
          failedDeviceCount:
            result.failedDeviceCount,
          invalidTokenCount:
            result.invalidTokenCount,
          messageIds: result.tokenResults
            .flatMap((tokenResult) =>
              tokenResult.messageId
                ? [tokenResult.messageId]
                : [],
            ),
          providerError:
            result.providerError,
          errorMessage:
            result.errorMessage,
        },
      );

      res.json(
        successResponse(
          {
            ...result,
            targetUserId: userId,
            explicitTokenProvided: Boolean(
              token,
            ),
            deepLinkPath,
          },
          result.deliveredDeviceCount > 0
            ? "Test push notification sent."
            : result.errorMessage ??
              "Push delivery is not connected on this backend yet.",
        ),
      );
    },
  );
