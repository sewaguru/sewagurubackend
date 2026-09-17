import { Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { AuthRequest } from "../types/types";
import {
  getFcmRegistrationTokenValidationError,
  maskDeviceToken,
  normalizeDeviceToken,
} from "../utils/fcm-token.util";

const assertAuthenticatedUser = (
  req: AuthRequest
) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401);
  }
  return req.user;
};

const VALID_PLATFORMS = new Set([
  "android",
  "ios",
  "web",
]);

const parseRequiredString = (
  value: unknown,
) =>
  typeof value === "string"
    ? value.trim()
    : "";

const parseOptionalString = (
  value: unknown,
) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const deviceTokenSelect = {
  id: true,
  userId: true,
  token: true,
  platform: true,
  deviceId: true,
  appVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;

//////////////////////////////////////////////////////
// REGISTER / UPDATE DEVICE TOKEN
//////////////////////////////////////////////////////

export const registerDeviceToken = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const token = normalizeDeviceToken(
      req.body.token,
    );
    const platform =
      parseRequiredString(
        req.body.platform,
      ).toLowerCase();
    const deviceId = parseOptionalString(
      req.body.deviceId,
    );
    const appVersion = parseOptionalString(
      req.body.appVersion,
    );

    const tokenValidationError =
      getFcmRegistrationTokenValidationError(
        token,
      );

    if (tokenValidationError) {
      throw new AppError(
        tokenValidationError,
        400,
        "INVALID_FCM_TOKEN"
      );
    }
    if (!VALID_PLATFORMS.has(platform)) {
      throw new AppError(
        "platform must be android, ios, or web",
        400
      );
    }

    const account =
      await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          deletionStatus: true,
        },
      });

    if (
      account?.deletionStatus ===
      "REQUESTED"
    ) {
      throw new AppError(
        "Device tokens cannot be registered while account deletion is scheduled.",
        409,
        "ACCOUNT_DELETION_REQUESTED"
      );
    }

    console.info(
      "[Push] Device token registration requested.",
      {
        authenticatedUserId: user.id,
        platform,
        deviceId,
        appVersion,
        token: maskDeviceToken(token),
      },
    );

    const existingToken =
      await prisma.deviceToken.findUnique({
        where: { token },
        select: {
          id: true,
          userId: true,
          platform: true,
          deviceId: true,
          appVersion: true,
        },
      });

    const savedToken =
      await prisma.deviceToken.upsert({
        where: { token },
        update: {
          userId: user.id,
          platform,
          deviceId,
          appVersion,
        },
        create: {
          token,
          platform,
          userId: user.id,
          deviceId,
          appVersion,
        },
        select: deviceTokenSelect,
      });

    const registrationAction =
      !existingToken
        ? "created"
        : existingToken.userId === user.id
          ? "updated"
          : "reassigned";

    console.info("[Push] Device token registered.", {
      action: registrationAction,
      tokenId: savedToken.id,
      userId: user.id,
      previousUserId:
        existingToken?.userId ?? null,
      platform,
      deviceId,
      appVersion,
      token: maskDeviceToken(token),
    });

    res.status(
      existingToken ? 200 : 201,
    ).json(
      successResponse(
        savedToken,
        "Device token registered",
      ),
    );
  }
);

//////////////////////////////////////////////////////
// UNREGISTER DEVICE TOKEN (logout / permission revoked)
//////////////////////////////////////////////////////

export const unregisterDeviceToken = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const token = normalizeDeviceToken(
      req.body.token,
    );

    if (!token) {
      throw new AppError(
        "token is required",
        400
      );
    }

    console.info(
      "[Push] Device token unregister requested.",
      {
        authenticatedUserId: user.id,
        token: maskDeviceToken(token),
      },
    );

    const deleted =
      await prisma.deviceToken.deleteMany({
        where: {
          token,
          userId: user.id,
        },
      });

    console.info("[Push] Device token unregister completed.", {
      userId: user.id,
      removedCount: deleted.count,
      token: maskDeviceToken(token),
    });

    res.json(
      successResponse(
        {
          removedCount:
            deleted.count,
          token,
          userId: user.id,
        },
        deleted.count > 0
          ? "Device token removed"
          : "Device token was already absent",
      ),
    );
  }
);
