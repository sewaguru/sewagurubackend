import crypto from "crypto";
import { config } from "../config/config";
import { prisma } from "../lib/prisma";
import { OTPType } from "../types/types";
import {
  assertSmsProviderReady,
  sendOtpSms,
} from "./sms.service";
import {
  assertEmailProviderReady,
  sendEmail,
} from "./email.service";
import { AppError } from "../utils/AppError";
import { securityLog } from "../utils/security.util";

const OTP_EXPIRY_MINUTES =
  config.OTP_EXPIRY_MINUTES;
const OTP_EXPIRY =
  OTP_EXPIRY_MINUTES * 60 * 1000;

const hashOtp = (otp: string) =>
  crypto.createHash("sha256").update(otp).digest("hex");

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// Test-account bypass for app store / play store review — scoped to an
// exact identifier match from config, never applies to any other account.
// See src/config/config.ts for the TEST_OTP_BYPASS_* validation.
const isTestBypassIdentifier = (
  identifier: string,
  identifierType: OTPIdentifierType
) => {
  if (!config.TEST_OTP_BYPASS_ENABLED) return false;

  if (identifierType === "EMAIL") {
    const target = config.TEST_OTP_BYPASS_EMAIL
      .trim()
      .toLowerCase();
    return (
      target !== "" &&
      identifier.trim().toLowerCase() === target
    );
  }

  // `identifier` arrives already normalised (e.g. "911234567890"), but the
  // configured value may be in any form ("1234567890", "+91 12345 67890").
  // Compare on the last 10 digits so phone formatting never causes a silent
  // bypass miss.
  const lastTen = (value: string) =>
    value.replace(/\D/g, "").slice(-10);
  const target = lastTen(config.TEST_OTP_BYPASS_PHONE);

  return target.length === 10 && lastTen(identifier) === target;
};

type OTPIdentifierType =
  | "PHONE"
  | "EMAIL";

type VerifyOTPInput = {
  identifier: string;
  identifierType: OTPIdentifierType;
  otp: string;
  type: OTPType;
};

export type VerifyOTPReason =
  | "VERIFIED"
  | "EMPTY_OTP"
  | "OTP_NOT_FOUND"
  | "OTP_EXPIRED"
  | "OTP_MISMATCH";

export type VerifyOTPResult = {
  valid: boolean;
  reason: VerifyOTPReason;
};

const getOtpMessageContent = (
  type: OTPType,
  otp: string
) => {
  switch (type) {
    case "REGISTER":
      return {
        subject:
          "Verify your phone for SewaGuru Partner",
        heading:
          "Registration OTP",
        intro:
          "Use this one-time password to verify your phone number:",
        outro:
          `This code is valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share it with anyone.`,
        text: `Your SewaGuru Partner registration OTP is ${otp}. This code is valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share it with anyone.`,
      };

    case "ACCOUNT_DELETE":
      return {
        subject:
          "Confirm your SewaGuru account deletion",
        heading:
          "Account deletion OTP",
        intro:
          "Use this one-time password to confirm account deletion:",
        outro:
          `This code is valid for ${OTP_EXPIRY_MINUTES} minutes. If you did not request account deletion, please ignore this message.`,
        text: `Your SewaGuru account deletion OTP is ${otp}. This code is valid for ${OTP_EXPIRY_MINUTES} minutes. If you did not request account deletion, please ignore this message.`,
      };

    default:
      return {
        subject:
          "Your SewaGuru login OTP",
        heading: "Login OTP",
        intro:
          "Your one-time password is:",
        outro:
          `This code is valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share it with anyone.`,
        text: `Your SewaGuru login OTP is ${otp}. This code is valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share it with anyone.`,
      };
  }
};

export async function createOTP(
  identifier: string,
  identifierType: OTPIdentifierType,
  type: OTPType
) {
  if (isTestBypassIdentifier(identifier, identifierType)) {
    // No real OTP is generated, stored, or sent — verifyOTP() accepts the
    // fixed TEST_OTP_BYPASS_CODE directly for this identifier.
    securityLog("OTP_SENT", {
      identifier,
      identifierType,
      scope: "TEST_BYPASS",
    });
    return config.TEST_OTP_BYPASS_CODE;
  }

  if (identifierType === "PHONE") {
    // Fail before DB write when SMS provider is unavailable.
    try {
      assertSmsProviderReady();
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : "OTP_SEND_FAILED";

      const message =
        error instanceof Error
          ? error.message
          : "Unknown OTP send error";

      securityLog("OTP_SEND_FAILED", {
        identifier,
        identifierType,
        reason: code,
        message,
        stage: "provider_check",
      });

      throw error;
    }
  }

  if (identifierType === "EMAIL") {
    // Fail before DB write when email provider is unavailable.
    try {
      assertEmailProviderReady();
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : "OTP_SEND_FAILED";

      const message =
        error instanceof Error
          ? error.message
          : "Unknown OTP send error";

      securityLog("OTP_SEND_FAILED", {
        identifier,
        identifierType,
        reason: code,
        message,
        stage: "provider_check",
      });

      throw error;
    }
  }

  await prisma.oTP.deleteMany({
    where: {
      identifier,
      identifierType,
      type,
      isUsed: false,
    },
  });

  const otp = generateOTP();
  const content =
    getOtpMessageContent(type, otp);
  const otpRecord = await prisma.oTP.create({
    data: {
      identifier,
      identifierType,
      codeHash: hashOtp(otp),
      type,
      expiresAt: new Date(Date.now() + OTP_EXPIRY),
    },
  });

  try {
    if (identifierType === "PHONE") {
      await sendOtpSms(identifier, otp);
    } else {
      await sendEmail(
        identifier,
        content.subject,
        `
        <div style="font-family:Arial, sans-serif; line-height:1.4;">
          <h2 style="margin:0 0 8px;">${content.heading}</h2>
          <p style="margin:0 0 12px;">
            ${content.intro}
          </p>
          <div style="font-size:28px; font-weight:700; letter-spacing:3px; margin:0 0 12px;">
            ${otp}
          </div>
          <p style="margin:0 0 6px;">
            ${content.outro}
          </p>
        </div>
        `
        ,
        content.text
      );

    }
  } catch (error) {
    const code =
      error instanceof AppError
        ? error.code
        : "OTP_SEND_FAILED";

    const message =
      error instanceof Error
        ? error.message
        : "Unknown OTP send error";

    securityLog("OTP_SEND_FAILED", {
      identifier,
      identifierType,
      reason: code,
      message,
    });

    await prisma.oTP.deleteMany({
      where: { id: otpRecord.id },
    });
    throw error;
  }

  return otp;
}
 
export async function verifyOTP({
  identifier,
  identifierType,
  otp,
  type,
}: VerifyOTPInput): Promise<VerifyOTPResult> {
  if (!otp) {
    securityLog("OTP_VERIFY_FAILED", {
      identifier,
      identifierType,
      type,
      reason: "EMPTY_OTP",
    });
    return {
      valid: false,
      reason: "EMPTY_OTP",
    };
  }

  if (isTestBypassIdentifier(identifier, identifierType)) {
    const bypassValid = otp === config.TEST_OTP_BYPASS_CODE;

    securityLog(
      bypassValid ? "OTP_VERIFY_SUCCESS" : "OTP_VERIFY_FAILED",
      {
        identifier,
        identifierType,
        type,
        scope: "TEST_BYPASS",
        ...(bypassValid ? {} : { reason: "OTP_MISMATCH" }),
      }
    );

    return bypassValid
      ? { valid: true, reason: "VERIFIED" }
      : { valid: false, reason: "OTP_MISMATCH" };
  }

  const record = await prisma.oTP.findFirst({
    where: {
      identifier,
      identifierType,
      type,
      isUsed: false,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!record) {
    securityLog("OTP_VERIFY_FAILED", {
      identifier,
      identifierType,
      type,
      reason: "OTP_NOT_FOUND",
    });
    return {
      valid: false,
      reason: "OTP_NOT_FOUND",
    };
  }

  if (record.expiresAt < new Date()) {
    await prisma.oTP.deleteMany({
      where: {
        identifier,
        identifierType,
        type,
        expiresAt: {
          lt: new Date(),
        },
      },
    });

    securityLog("OTP_VERIFY_FAILED", {
      identifier,
      identifierType,
      type,
      reason: "OTP_EXPIRED",
    });
    return {
      valid: false,
      reason: "OTP_EXPIRED",
    };
  }

  if (hashOtp(otp) !== record.codeHash) {
    securityLog("OTP_VERIFY_FAILED", {
      identifier,
      identifierType,
      type,
      reason: "OTP_MISMATCH",
    });
    return {
      valid: false,
      reason: "OTP_MISMATCH",
    };
  }

  //////////////////////////////////////////////////
  // DELETE OTP AFTER SUCCESS
  //////////////////////////////////////////////////
  await prisma.oTP.deleteMany({
    where: {
      identifier: record.identifier,
      identifierType: record.identifierType,
      type: record.type,
    },
  });

  securityLog("OTP_VERIFY_SUCCESS", {
    identifier,
    identifierType,
    type,
  });


  return {
    valid: true,
    reason: "VERIFIED",
  };
}
