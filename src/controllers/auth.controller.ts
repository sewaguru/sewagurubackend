import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";

import {
  createOTP,
  verifyOTP,
} from "../services/otp.service";

import {
  signToken,
  setAuthCookie,
  clearAuthCookie,
} from "../utils/token.util";
import { securityLog } from "../utils/security.util";
import { AuthRequest } from "../types/types";
import {
  getIdentifierLookupCandidates,
  normalizeAuthIdentifier,
} from "../utils/identifier.util";
import { config } from "../config/config";
import { sendSignupWelcomeEmail } from "../services/emailManagement.service";
import {
  assertIdentifierNotPermanentlyDeleted,
  resolveAccountDeletionOnLogin,
} from "../services/account-deletion.service";

const otpFailureMessage = (
  reason: "VERIFIED" | "EMPTY_OTP" | "OTP_NOT_FOUND" | "OTP_EXPIRED" | "OTP_MISMATCH"
) => {
  if (
    reason === "OTP_NOT_FOUND" ||
    reason === "OTP_EXPIRED"
  ) {
    return "OTP expired. Please request a new code and try again.";
  }

  return "Invalid OTP";
};

const findAuthByIdentifier = async (
  rawIdentifier: string,
  normalizedIdentifier: string,
  identifierType: "PHONE" | "EMAIL"
) =>
  prisma.userAuth.findFirst({
    where: {
      provider: {
        in: ["PHONE_OTP", "EMAIL_OTP"],
      },
      identifierType,
      identifier: {
        in: getIdentifierLookupCandidates(
          rawIdentifier,
          normalizedIdentifier,
          identifierType
        ),
      },
    },
    include: { user: true },
  });

const maskEmail = (email: string) => {
  const value = email.trim();
  const at = value.indexOf("@");
  if (at <= 0) return "***";

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);

  const prefix =
    local.length <= 2
      ? local.slice(0, 1)
      : local.slice(0, 2);

  return `${prefix}***@${domain}`;
};

const maskPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
};

//////////////////////////////////////////////////////
// USER OTP SEND
//////////////////////////////////////////////////////

export const sendOtp = catchAsync(
  async (req: Request, res: Response) => {
    const { identifier } = req.body;
    if (!identifier)
      throw new AppError(
        "Phone or Email required",
        400
      );

    const {
      identifier: normalizedIdentifier,
      identifierType,
    } = normalizeAuthIdentifier(
      identifier
    );

    await assertIdentifierNotPermanentlyDeleted({
      identifier:
        normalizedIdentifier,
      identifierType,
    });

    await createOTP(
      normalizedIdentifier,
      identifierType,
      "LOGIN"
    );

    securityLog("OTP_SENT", {
      identifier:
        normalizedIdentifier,
      identifierType,
      scope: "USER",
    });

    const sentTo =
      identifierType === "EMAIL"
        ? maskEmail(normalizedIdentifier)
        : maskPhone(normalizedIdentifier);

    res.json(
      successResponse(null, "OTP sent", {
        identifierType,
        sentTo,
        provider:
          identifierType === "EMAIL"
            ? config.EMAIL_PROVIDER
            : "RAPID_SMS",
      })
    );
  }
);

//////////////////////////////////////////////////////
// USER OTP VERIFY
//////////////////////////////////////////////////////

export const verifyOtp = catchAsync(
  async (req: Request, res: Response) => {

    const { identifier, otp } = req.body;
    if (!identifier || !otp) {
      throw new AppError(
        "identifier and otp are required",
        400
      );
    }

    const {
      identifier: normalizedIdentifier,
      identifierType,
      rawIdentifier,
    } = normalizeAuthIdentifier(
      identifier
    );

    const verification =
      await verifyOTP({
        identifier:
          normalizedIdentifier,
        identifierType,
        otp,
        type: "LOGIN",
      });

    if (!verification.valid) {
      securityLog("LOGIN_FAILED", {
        identifier:
          normalizedIdentifier,
        type: "USER",
        otpReason:
          verification.reason,
      });
      throw new AppError(
        otpFailureMessage(
          verification.reason
        ),
        400
      );
    }

    //////////////////////////////////////////////////
    // FIND AUTH METHOD
    //////////////////////////////////////////////////
    const existingAuth =
      await findAuthByIdentifier(
        rawIdentifier,
        normalizedIdentifier,
        identifierType
      );

    let user;
    let isNewUser = false;
    let deletionCancellation:
      | Awaited<
          ReturnType<
            typeof resolveAccountDeletionOnLogin
          >
        >
      | null = null;

    //////////////////////////////////////////////////
    // EXISTING USER
    //////////////////////////////////////////////////
    if (existingAuth) {
      user = existingAuth.user;
    }

    //////////////////////////////////////////////////
    // AUTO CREATE USER
    //////////////////////////////////////////////////
    else {
      isNewUser = true;

      await assertIdentifierNotPermanentlyDeleted(
        {
          identifier:
            normalizedIdentifier,
          identifierType,
        }
      );

      user = await prisma.user.create({
        data: {
          authMethods: {
            create: {
              provider:
                identifierType === "EMAIL"
                ? "EMAIL_OTP"
                : "PHONE_OTP",

              identifierType:
                identifierType,

              identifier:
                normalizedIdentifier,
              isVerified: true,
              isPrimary: true,
            },
          },

          profile: {
            create: {
              fullName: "User",
              ...(identifierType ===
              "EMAIL"
                ? {
                    email:
                      normalizedIdentifier,
                  }
                : {}),
            },
          },
        },
      });
    }

    //////////////////////////////////////////////////
    // LOGIN
    //////////////////////////////////////////////////
    deletionCancellation =
      await resolveAccountDeletionOnLogin(
        user.id
      );

    if (user.isBlocked || !user.isActive) {
      throw new AppError(
        "Account is blocked",
        403
      );
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastActiveAt:
          new Date(),
      },
    });

    const token = signToken({
      id: user.id,
      role: user.role,
    });

    setAuthCookie(res, token);

    securityLog("USER_LOGIN", {
      userId: user.id,
      role: user.role,
      identifierType,
    });

    if (isNewUser) {
      void sendSignupWelcomeEmail(
        user.id
      ).catch((error) => {
        console.error(
          "[EMAIL] Failed to send welcome email",
          {
            userId: user.id,
            error,
          }
        );
      });
    }

    res.json(
      successResponse(
        user,
        "Login successful",
        deletionCancellation.cancelled
          ? {
              accountDeletionCancelled: true,
              accountDeletionCancellationMessage:
                deletionCancellation.message,
            }
          : undefined
      )
    );
  }
);


//////////////////////////////////////////////////////
// ADMIN LOGIN
//////////////////////////////////////////////////////

const ADMIN_ROLES = [
  "ADMIN",
  "BRANCH_ADMIN",
  "SUPER_ADMIN",
];

//////////////////////////////////////////////////////
// SEND ADMIN OTP
//////////////////////////////////////////////////////

export const sendAdminOtp = catchAsync(
  async (req: Request, res: Response) => {

    const { identifier } = req.body;

    if (!identifier)
      throw new AppError(
        "Identifier required",
        400
      );

    const {
      identifier: normalizedIdentifier,
      identifierType,
      rawIdentifier,
    } = normalizeAuthIdentifier(
      identifier
    );

    const auth =
      await findAuthByIdentifier(
        rawIdentifier,
        normalizedIdentifier,
        identifierType
      );

    if (!auth)
      throw new AppError(
        "Admin not found",
        404
      );

    if (
      !ADMIN_ROLES.includes(
        auth.user.role
      )
    ) {
      securityLog("UNAUTHORIZED_ACCESS", {
        identifier:
          normalizedIdentifier,
        reason: "Non-admin tried admin OTP",
      });
      throw new AppError(
        "Unauthorized",
        403
      );
    }

    await createOTP(
      normalizedIdentifier,
      identifierType,
      "LOGIN"
    );

    securityLog("OTP_SENT", {
      identifier:
        normalizedIdentifier,
      identifierType,
      scope: "ADMIN",
    });

    const sentTo =
      identifierType === "EMAIL"
        ? maskEmail(normalizedIdentifier)
        : maskPhone(normalizedIdentifier);

    res.json(
      successResponse(null, "OTP sent", {
        identifierType,
        sentTo,
        provider:
          identifierType === "EMAIL"
            ? config.EMAIL_PROVIDER
            : "RAPID_SMS",
      })
    );
  }
);

//////////////////////////////////////////////////////
// VERIFY ADMIN OTP
//////////////////////////////////////////////////////

export const verifyAdminOtp = catchAsync(
  async (req: Request, res: Response) => {

    const { identifier, otp } = req.body;
    if (!identifier || !otp) {
      throw new AppError(
        "identifier and otp are required",
        400
      );
    }

    const {
      identifier: normalizedIdentifier,
      identifierType,
      rawIdentifier,
    } = normalizeAuthIdentifier(
      identifier
    );

    const verification =
      await verifyOTP({
        identifier:
          normalizedIdentifier,
        identifierType,
        otp,
        type: "LOGIN",
      });

    if (!verification.valid) {
      securityLog("LOGIN_FAILED", {
        identifier:
          normalizedIdentifier,
        type: "ADMIN",
        otpReason:
          verification.reason,
      });
      throw new AppError(
        otpFailureMessage(
          verification.reason
        ),
        400
      );
    }

    const auth =
      await findAuthByIdentifier(
        rawIdentifier,
        normalizedIdentifier,
        identifierType
      );

    if (!auth)
      throw new AppError(
        "User not found",
        404
      );

    if (
      !ADMIN_ROLES.includes(
        auth.user.role
      )
    ) {
      securityLog("UNAUTHORIZED_ACCESS", {
        identifier:
          normalizedIdentifier,
        reason: "Non-admin used admin OTP",
      });
      throw new AppError(
        "Admin access denied",
        403
      );
    }

    if (
      auth.user.isBlocked ||
      !auth.user.isActive
    ) {
      throw new AppError(
        "Account is blocked",
        403
      );
    }

    await prisma.user.update({
      where: {
        id: auth.user.id,
      },
      data: {
        lastActiveAt:
          new Date(),
      },
    });

    const token = signToken({
      id: auth.user.id,
      role: auth.user.role,
      panel: "ADMIN",
    });

    setAuthCookie(res, token);

    securityLog("ADMIN_LOGIN", {
      userId: auth.user.id,
      role: auth.user.role,
    });

    res.json(
      successResponse(
        auth.user,
        "Admin login success"
      )
    );
  }
);

//////////////////////////////////////////////////////
// LOGOUT
//////////////////////////////////////////////////////

export const logout = (
  _: Request,
  res: Response
) => {
  clearAuthCookie(res);

  res.json(successResponse(null));
};

//////////////////////////////////////////////////////
// GET CURRENT USER
//////////////////////////////////////////////////////

export const getMe = catchAsync(
  async (req: AuthRequest, res: Response) => {

    const user =
      await prisma.user.findUnique({
        where: {
          id: req.user!.id,
        },
        include: {
          profile: true,
          authMethods: true,
        },
      });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );
    res.setHeader("Pragma", "no-cache");

    res.json(successResponse(user));
  }
);
