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
} from "../utils/token.util";
import { securityLog } from "../utils/security.util";
import { AuthRequest } from "../types/types";
import {
  getIdentifierLookupCandidates,
  normalizeAuthIdentifier,
} from "../utils/identifier.util";
import {
  assertIdentifierNotPermanentlyDeleted,
  resolveAccountDeletionOnLogin,
} from "../services/account-deletion.service";
import { getOnboardingStatusForUser } from "../services/professional.service";
import { Role } from "../generated/prisma";

const ADMIN_ROLES: Role[] = [
  Role.ADMIN,
  Role.BRANCH_ADMIN,
  Role.SUPER_ADMIN,
];

const otpFailureMessage = (
  reason:
    | "VERIFIED"
    | "EMPTY_OTP"
    | "OTP_NOT_FOUND"
    | "OTP_EXPIRED"
    | "OTP_MISMATCH"
) => {
  if (
    reason === "OTP_NOT_FOUND" ||
    reason === "OTP_EXPIRED"
  ) {
    return "OTP expired. Please request a new code and try again.";
  }

  return "Invalid OTP";
};

const maskPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
};

// Professionals register/login by phone only.
const requirePhoneIdentifier = (rawPhone: unknown) => {
  if (typeof rawPhone !== "string" || !rawPhone.trim()) {
    throw new AppError("Phone number is required", 400);
  }

  const normalized = normalizeAuthIdentifier(rawPhone);

  if (normalized.identifierType !== "PHONE") {
    throw new AppError(
      "Professional registration requires a phone number, not an email.",
      400,
      "PHONE_REQUIRED"
    );
  }

  return normalized;
};

const findAuthByPhone = (
  rawIdentifier: string,
  normalizedIdentifier: string
) =>
  prisma.userAuth.findFirst({
    where: {
      provider: "PHONE_OTP",
      identifierType: "PHONE",
      identifier: {
        in: getIdentifierLookupCandidates(
          rawIdentifier,
          normalizedIdentifier,
          "PHONE"
        ),
      },
    },
    include: { user: true },
  });

//////////////////////////////////////////////////////
// SEND PROFESSIONAL REGISTRATION/LOGIN OTP
//////////////////////////////////////////////////////

export const sendProfessionalOtp = catchAsync(
  async (req: Request, res: Response) => {
    const { identifier: normalizedIdentifier, rawIdentifier } =
      requirePhoneIdentifier(req.body?.phone);

    await assertIdentifierNotPermanentlyDeleted({
      identifier: normalizedIdentifier,
      identifierType: "PHONE",
    });

    const existingAuth = await findAuthByPhone(
      rawIdentifier,
      normalizedIdentifier
    );

    if (
      existingAuth &&
      ADMIN_ROLES.includes(existingAuth.user.role)
    ) {
      securityLog("UNAUTHORIZED_ACCESS", {
        identifier: normalizedIdentifier,
        reason:
          "Admin phone used for professional registration",
      });
      throw new AppError(
        "This phone number cannot be used for professional registration.",
        403,
        "PHONE_NOT_ELIGIBLE"
      );
    }

    await createOTP(normalizedIdentifier, "PHONE", "REGISTER");

    securityLog("OTP_SENT", {
      identifier: normalizedIdentifier,
      identifierType: "PHONE",
      scope: "PROFESSIONAL",
    });

    res.json(
      successResponse(null, "OTP sent", {
        identifierType: "PHONE",
        sentTo: maskPhone(normalizedIdentifier),
        provider: "RAPID_SMS",
      })
    );
  }
);

//////////////////////////////////////////////////////
// VERIFY PROFESSIONAL REGISTRATION/LOGIN OTP
//////////////////////////////////////////////////////

export const verifyProfessionalOtp = catchAsync(
  async (req: Request, res: Response) => {
    const { identifier: normalizedIdentifier, rawIdentifier } =
      requirePhoneIdentifier(req.body?.phone);

    const otp =
      typeof req.body?.otp === "string" ? req.body.otp : "";

    if (!otp) {
      throw new AppError("otp is required", 400);
    }

    const verification = await verifyOTP({
      identifier: normalizedIdentifier,
      identifierType: "PHONE",
      otp,
      type: "REGISTER",
    });

    if (!verification.valid) {
      securityLog("LOGIN_FAILED", {
        identifier: normalizedIdentifier,
        type: "PROFESSIONAL",
        otpReason: verification.reason,
      });
      throw new AppError(
        otpFailureMessage(verification.reason),
        400
      );
    }

    const existingAuth = await findAuthByPhone(
      rawIdentifier,
      normalizedIdentifier
    );

    let user;
    let isNewProfessional = false;

    if (existingAuth) {
      if (ADMIN_ROLES.includes(existingAuth.user.role)) {
        securityLog("UNAUTHORIZED_ACCESS", {
          identifier: normalizedIdentifier,
          reason:
            "Admin phone used for professional registration",
        });
        throw new AppError(
          "This phone number cannot be used for professional registration.",
          403,
          "PHONE_NOT_ELIGIBLE"
        );
      }

      user = existingAuth.user;

      // A returning customer becomes a professional too, on the same
      // account — we do not create a second identity for the same phone.
      if (user.role === Role.USER) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { role: Role.PROFESSIONAL },
        });

        securityLog("USER_LOGIN", {
          userId: user.id,
          role: user.role,
          scope: "PROFESSIONAL",
          note: "Promoted existing customer account to PROFESSIONAL",
        });
      }
    } else {
      isNewProfessional = true;

      await assertIdentifierNotPermanentlyDeleted({
        identifier: normalizedIdentifier,
        identifierType: "PHONE",
      });

      user = await prisma.user.create({
        data: {
          role: Role.PROFESSIONAL,
          authMethods: {
            create: {
              provider: "PHONE_OTP",
              identifierType: "PHONE",
              identifier: normalizedIdentifier,
              isVerified: true,
              isPrimary: true,
            },
          },
        },
      });
    }

    const deletionCancellation =
      await resolveAccountDeletionOnLogin(user.id);

    if (user.isBlocked || !user.isActive) {
      throw new AppError("Account is blocked", 403);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    const token = signToken({
      id: user.id,
      role: user.role,
    });

    setAuthCookie(res, token);

    securityLog("USER_LOGIN", {
      userId: user.id,
      role: user.role,
      identifierType: "PHONE",
      scope: "PROFESSIONAL",
    });

    const { profile, onboarding } =
      await getOnboardingStatusForUser(user.id);

    res.json(
      successResponse(
        {
          user: {
            id: user.id,
            role: user.role,
          },
          professionalProfile: profile,
          onboarding,
          isNewProfessional,
        },
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
// CURRENT PROFESSIONAL SESSION
//////////////////////////////////////////////////////

export const getMeProfessional = catchAsync(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError("Unauthorized", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    const { profile, onboarding } =
      await getOnboardingStatusForUser(user.id);

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");

    res.json(
      successResponse({
        user,
        professionalProfile: profile,
        onboarding,
      })
    );
  }
);
