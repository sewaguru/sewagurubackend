import crypto from "crypto";
import { prisma } from "../lib/prisma";
import {
  assertEmailProviderReady,
  sendEmail,
} from "./email.service";
import { AppError } from "../utils/AppError";
import { clearUserCache } from "../utils/cache";
import { config } from "../config/config";

//////////////////////////////////////////////////////
// CONFIG
//////////////////////////////////////////////////////

const TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour
const RESEND_COOLDOWN = 30 * 1000;

//////////////////////////////////////////////////////
// GENERATE EMAIL VERIFICATION
//////////////////////////////////////////////////////

export const generateAndSendVerification =
  async (
    userId: string
  ): Promise<{ sentTo: string }> => {
    const emailEnabled = config.EMAIL_ENABLED;

    // Always require a configured email provider; never auto-open verification links.
    if (!emailEnabled) {
      throw new AppError(
        "Email service is not configured",
        503,
        "EMAIL_DISABLED"
      );
    }

    // Ensure we never "succeed" without actually having a working email provider.
    assertEmailProviderReady();

    //////////////////////////////////////////////////
    // FIND CONTACT EMAIL (USER PROFILE)
    //////////////////////////////////////////////////
    const profile =
      await prisma.userProfile.findUnique({
        where: { userId },
        select: { email: true },
      });

    const email =
      profile?.email?.trim().toLowerCase() ??
      null;

    if (!email)
      throw new AppError(
        "Please add an email address to your profile first.",
        400,
        "EMAIL_NOT_FOUND"
      );

    //////////////////////////////////////////////////
    // ENSURE A VERIFIABLE EMAIL AUTH RECORD EXISTS (CONTACT EMAIL)
    //////////////////////////////////////////////////
    const contactEmailAuth =
      await prisma.userAuth.findFirst({
        where: {
          userId,
          provider: "GUEST",
          identifierType: "EMAIL",
        },
      });

    if (
      contactEmailAuth &&
      contactEmailAuth.identifier !== email
    ) {
      // Keep the auth record aligned with the profile email.
      await prisma.userAuth.update({
        where: { id: contactEmailAuth.id },
        data: {
          identifier: email,
          isVerified: false,
          isPrimary: false,
        },
      });
    } else if (!contactEmailAuth) {
      await prisma.userAuth.create({
        data: {
          userId,
          provider: "GUEST",
          identifierType: "EMAIL",
          identifier: email,
          isVerified: false,
          isPrimary: false,
        },
      });
    }

    const refreshedAuth =
      contactEmailAuth &&
      contactEmailAuth.identifier === email
        ? contactEmailAuth
        : await prisma.userAuth.findFirst({
            where: {
              userId,
              provider: "GUEST",
              identifierType: "EMAIL",
              identifier: email,
            },
          });

    if (refreshedAuth?.isVerified)
      throw new AppError(
        "Email is already verified.",
        400,
        "EMAIL_ALREADY_VERIFIED"
      );

    //////////////////////////////////////////////////
    // RESEND COOLDOWN
    //////////////////////////////////////////////////
    const existing =
      await prisma.emailVerificationToken.findUnique({
        where: { userId },
      });

    if (existing) {
      const diff =
        Date.now() -
        existing.createdAt.getTime();

      if (diff < RESEND_COOLDOWN)
        throw new AppError(
          "Please wait a few seconds before retrying.",
          429,
          "EMAIL_RESEND_COOLDOWN"
        );

      await prisma.emailVerificationToken.delete({
        where: { userId },
      });
    }

    //////////////////////////////////////////////////
    // CREATE TOKEN
    //////////////////////////////////////////////////
    const rawToken =
      crypto.randomBytes(32).toString("hex");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    await prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(
          Date.now() + TOKEN_EXPIRY
        ),
      },
    });

    //////////////////////////////////////////////////
    // EMAIL LINK
    //////////////////////////////////////////////////
    const baseUrl = config.CLIENT_URL.replace(
      /\/+$/,
      ""
    );
    const verifyUrl =
      `${baseUrl}/verify-email?token=${rawToken}`;

    try {
      const expiresIn = "1 hour";

      await sendEmail(
        email,
        "Verify your email for SewaGuru",
        `
      <div style="background:#f6f7fb; padding:24px 0;">
        <div style="max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e8e9ef; border-radius:14px; overflow:hidden;">
          <div style="padding:20px 24px; border-bottom:1px solid #f0f1f5;">
            <div style="font-family:Arial, sans-serif; font-size:18px; font-weight:700; color:#111827;">
              SewaGuru
            </div>
            <div style="font-family:Arial, sans-serif; font-size:12px; color:#6b7280; margin-top:4px;">
              Verify your email address
            </div>
          </div>

          <div style="padding:22px 24px 10px 24px;">
            <div style="font-family:Arial, sans-serif; font-size:16px; font-weight:700; color:#111827; margin:0 0 10px 0;">
              Confirm your email
            </div>

            <div style="font-family:Arial, sans-serif; font-size:14px; color:#111827; line-height:1.5;">
              We received a request to verify this email address for your SewaGuru account.
              Click the button below to confirm.
            </div>

            <div style="margin:18px 0 8px 0;">
              <a href="${verifyUrl}" style="display:inline-block; padding:12px 16px; background:#111827; color:#ffffff; text-decoration:none; border-radius:10px; font-family:Arial, sans-serif; font-size:14px; font-weight:700;">
                Verify Email
              </a>
            </div>

            <div style="font-family:Arial, sans-serif; font-size:12px; color:#6b7280; line-height:1.5; margin-top:10px;">
              This link expires in ${expiresIn}.
              If you didn’t request this, you can safely ignore this email.
            </div>

            <div style="font-family:Arial, sans-serif; font-size:12px; color:#6b7280; line-height:1.5; margin-top:12px;">
              Having trouble with the button? Copy and paste this link into your browser:
              <div style="word-break:break-all; color:#111827; margin-top:6px;">
                <a href="${verifyUrl}" style="color:#111827; text-decoration:underline;">${verifyUrl}</a>
              </div>
            </div>
          </div>

          <div style="padding:14px 24px 18px 24px;">
            <div style="font-family:Arial, sans-serif; font-size:11px; color:#9ca3af; line-height:1.5;">
              Need help? Reply to this email and our team will assist you.
            </div>
          </div>
        </div>
      </div>
      `,
        `SewaGuru email verification\n\nOpen this link to verify your email:\n${verifyUrl}\n\nThis link expires in ${expiresIn}. If you didn’t request this, you can ignore this email.`
      );
    } catch (err) {
      // If the provider fails, remove the token so the user can retry quickly.
      try {
        await prisma.emailVerificationToken.delete({
          where: { userId },
        });
      } catch {
        // ignore
      }

      console.error(
        "[EMAIL][VERIFY][SEND_FAILED]",
        {
          userId,
          email,
          error:
            err instanceof Error
              ? err.message
              : String(err),
        }
      );

      if (err instanceof AppError) {
        throw err;
      }

      throw new AppError(
        "Failed to send verification email",
        502,
        "EMAIL_SEND_FAILED"
      );
    }

    return { sentTo: email };
  };

//////////////////////////////////////////////////////
// VERIFY EMAIL TOKEN
//////////////////////////////////////////////////////

export const verifyEmailToken =
  async (token: string): Promise<void> => {

    if (!token)
      throw new AppError(
        "Invalid token",
        400,
        "EMAIL_TOKEN_INVALID"
      );

    //////////////////////////////////////////////////
    // HASH TOKEN
    //////////////////////////////////////////////////
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const record =
      await prisma.emailVerificationToken.findUnique({
        where: { tokenHash },
      });

    if (!record)
      throw new AppError(
        "Invalid or already used verification link.",
        400,
        "EMAIL_TOKEN_INVALID"
      );

    const now = new Date();

    if (record.expiresAt < now) {
      // Cleanup expired token record to keep the table small.
      try {
        await prisma.emailVerificationToken.delete({
          where: { userId: record.userId },
        });
      } catch {
        // ignore
      }

      // If the email is already verified, treat this as success (idempotent UX).
      const verifiedAuth = await prisma.userAuth.findFirst({
        where: {
          userId: record.userId,
          provider: "GUEST",
          identifierType: "EMAIL",
          isVerified: true,
        },
        select: { id: true },
      });

      if (verifiedAuth) {
        clearUserCache(record.userId);
        return;
      }

      throw new AppError(
        "Verification link expired. Please request a new one.",
        400,
        "EMAIL_TOKEN_EXPIRED"
      );
    }

    //////////////////////////////////////////////////
    // VERIFY EMAIL AUTH
    //////////////////////////////////////////////////
    const profile =
      await prisma.userProfile.findUnique({
        where: { userId: record.userId },
        select: { email: true },
      });

    const email =
      profile?.email?.trim().toLowerCase() ??
      null;

    await prisma.userAuth.updateMany({
      where: {
        userId: record.userId,
        provider: "GUEST",
        identifierType: "EMAIL",
        ...(email ? { identifier: email } : {}),
      },
      data: { isVerified: true },
    });

    // NOTE: Do not delete the token immediately. Some clients prefetch links or the app may retry.
    // Keeping it until expiry makes verification idempotent and avoids "already used" failures.

    //////////////////////////////////////////////////
    // CLEAR CACHE
    //////////////////////////////////////////////////
    clearUserCache(record.userId);
  };
