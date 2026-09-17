import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { config } from "../config/config";
import { clearUserCache } from "../utils/cache";

import {
  generateAndSendVerification,
  verifyEmailToken,
} from "../services/emailVerification.service";
import {
  createOTP,
  verifyOTP,
} from "../services/otp.service";
import {
  moveUserToTrash,
} from "../services/trash.service";
import { clearAuthCookie } from "../utils/token.util";
import {
  AccountDeletionReason,
  PaymentStatus,
  Prisma,
  Role,
} from "../generated/prisma";
import { normalizeIdentifier } from "../utils/identifier.util";
import { requestAccountDeletion } from "../services/account-deletion.service";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const extractIdentifiers = (authMethods: any[]) => {
  const phone =
    authMethods.find(
      (a) => a.identifierType === "PHONE"
    )?.identifier?.trim() || null;

  const email =
    authMethods.find(
      (a) => a.identifierType === "EMAIL"
    )?.identifier?.trim() || null;

  return { phone, email };
};

const maskDeleteOtpDestination = (
  identifier: string,
  channel: "PHONE" | "EMAIL"
) => {
  if (channel === "EMAIL") {
    const value = identifier.trim();
    const at = value.indexOf("@");

    if (at <= 0) {
      return "***";
    }

    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const prefix =
      local.length <= 2
        ? local.slice(0, 1)
        : local.slice(0, 2);

    return `${prefix}***@${domain}`;
  }

  const digits = identifier.replace(/\D/g, "");

  if (digits.length < 4) {
    return "***";
  }

  return `***${digits.slice(-4)}`;
};

const resolveDeleteOtpTarget = (
  authMethods: Array<{
    identifierType: "PHONE" | "EMAIL";
    identifier: string;
    isVerified: boolean;
    isPrimary: boolean;
  }>,
  requestedChannel?: "PHONE" | "EMAIL"
) => {
  const pickIdentifier = (
    channel: "PHONE" | "EMAIL"
  ) => {
    const scoped =
      authMethods.filter(
        (method) =>
          method.identifierType === channel &&
          typeof method.identifier === "string" &&
          method.identifier.trim().length > 0
      );

    if (scoped.length === 0) {
      return null;
    }

    return (
      scoped.find(
        (method) =>
          method.isPrimary &&
          method.isVerified
      ) ??
      scoped.find(
        (method) => method.isVerified
      ) ??
      scoped.find(
        (method) => method.isPrimary
      ) ??
      scoped[0] ??
      null
    );
  };

  if (requestedChannel) {
    const selected =
      pickIdentifier(requestedChannel);

    if (!selected) {
      throw new AppError(
        requestedChannel === "EMAIL"
          ? "Add an email address to receive the delete OTP."
          : "Add a phone number to receive the delete OTP.",
        400,
        requestedChannel === "EMAIL"
          ? "DELETE_OTP_EMAIL_UNAVAILABLE"
          : "DELETE_OTP_PHONE_UNAVAILABLE"
      );
    }

    return {
      channel: requestedChannel,
      identifier:
        selected.identifier.trim(),
    };
  }

  const phone = pickIdentifier("PHONE");

  if (phone) {
    return {
      channel: "PHONE" as const,
      identifier:
        phone.identifier.trim(),
    };
  }

  const email = pickIdentifier("EMAIL");

  if (email) {
    return {
      channel: "EMAIL" as const,
      identifier:
        email.identifier.trim(),
    };
  }

  throw new AppError(
    "Add a phone number or email address before requesting account deletion.",
    400,
    "DELETE_OTP_CONTACT_UNAVAILABLE"
  );
};

const parseUserFilterDate = (
  rawValue?: string,
  endOfDay = false
) => {
  if (
    typeof rawValue !== "string" ||
    rawValue.trim().length === 0
  ) {
    return null;
  }

  const trimmed = rawValue.trim();
  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      `Invalid date value: ${trimmed}`,
      400
    );
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (endOfDay) {
      parsed.setHours(23, 59, 59, 999);
    } else {
      parsed.setHours(0, 0, 0, 0);
    }
  }

  return parsed;
};

const combineUserWhere = (
  ...conditions: Array<
    Prisma.UserWhereInput | null | undefined
  >
): Prisma.UserWhereInput => {
  const validConditions: Prisma.UserWhereInput[] =
    [];

  for (const condition of conditions) {
    if (
      condition &&
      Object.keys(condition).length > 0
    ) {
      validConditions.push(condition);
    }
  }

  if (validConditions.length === 0) {
    return {};
  }

  if (validConditions.length === 1) {
    return validConditions[0]!;
  }

  return {
    AND: validConditions,
  };
};

//////////////////////////////////////////////////////
// GET USER PROFILE (APP)
//////////////////////////////////////////////////////

export const getProfile = catchAsync(
  async (req: Request, res: Response) => {

    const userId = (req as any).user.id;

    //////////////////////////////////////////////////
    // FETCH USER
    //////////////////////////////////////////////////
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
      profile: true,
      authMethods: true,
      addresses: {
          where: { isActive: true },
          orderBy: { isPrimary: "desc" },
        },
      },
    });

    if (!user)
      throw new AppError("User not found", 404);

    const { phone, email: authEmail } =
      extractIdentifiers(user.authMethods);

    // Normalize possible legacy empty-string values to null.
    const profileEmail = user.profile?.email?.trim() || null;

    // Prefer profile.email (admin-managed), but fall back to any email auth method if present.
    const email = profileEmail ?? authEmail;

    const emailAuthRecord = email
      ? user.authMethods.find(
          (a) =>
            a.identifierType === "EMAIL" &&
            a.provider === "GUEST" &&
            a.identifier === email
        ) ?? null
      : null;

    const formatted = {
      id: user.id,
      role: user.role,
      createdAt: user.createdAt,

      phone,
      email,
      isEmailVerified:
        emailAuthRecord?.isVerified ?? false,

      fullName:
        user.profile?.fullName ?? null,

      gender:
        user.profile?.gender ?? null,

      dateOfBirth:
        user.profile?.dateOfBirth ?? null,

      profileImage:
        user.profile?.profileImageUrl ??
        null,

      deletionStatus:
        user.deletionStatus,
      deletionRequestedAt:
        user.deletionRequestedAt,
      deletionScheduledFor:
        user.deletionScheduledFor,
      deletionCancelledAt:
        user.deletionCancelledAt,
      deletionCompletedAt:
        user.deletionCompletedAt,

      addresses: user.addresses,
    };

    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );
    res.setHeader("Pragma", "no-cache");

    res.json(
      successResponse(
        formatted,
        "Profile fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// UPDATE PROFILE
//////////////////////////////////////////////////////

export const updateProfile = catchAsync(
  async (req: Request, res: Response) => {

    const userId = (req as any).user.id;

    const {
      fullName,
      email: emailInput,
      phone: phoneInput,
      gender,
      dateOfBirth,
    } = req.body;

    const normalizedFullName =
      typeof fullName === "string"
        ? fullName.trim()
        : undefined;

    if (
      typeof fullName === "string" &&
      !normalizedFullName
    )
      throw new AppError(
        "Full name required",
        400,
        "FULL_NAME_REQUIRED"
      );

    const trimmedEmail =
      typeof emailInput === "string"
        ? emailInput.trim()
        : emailInput === null
        ? ""
        : undefined;

    const normalizedEmail =
      trimmedEmail === undefined
        ? undefined
        : trimmedEmail.length === 0
        ? null
        : trimmedEmail.toLowerCase();

    const trimmedPhone =
      typeof phoneInput === "string"
        ? phoneInput.trim()
        : phoneInput === null
        ? ""
        : undefined;

    const normalizedPhone =
      trimmedPhone === undefined
        ? undefined
        : trimmedPhone.length === 0
        ? null
        : normalizeIdentifier(
            trimmedPhone,
            "PHONE"
          );

    if (
      normalizedEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        normalizedEmail
      )
    ) {
      throw new AppError(
        "Invalid email address",
        400,
        "INVALID_EMAIL"
      );
    }

    const profile = await prisma
      .$transaction(
        async (tx) => {
          if (normalizedEmail !== undefined) {
            console.log("[PROFILE][UPDATE]", {
              userId,
              email: normalizedEmail,
            });
          }

          const existingProfile =
            normalizedEmail !== undefined ||
            normalizedFullName !== undefined ||
            normalizedPhone !== undefined
              ? await tx.userProfile.findUnique({
                  where: { userId },
                  select: {
                    email: true,
                    fullName: true,
                  },
                })
              : null;

          const previousEmail =
            existingProfile?.email?.trim().toLowerCase() ??
            null;

          const profileUpdateData: Prisma.UserProfileUpdateInput =
            {
            ...(normalizedFullName !== undefined
              ? {
                  fullName:
                    normalizedFullName,
                }
              : {}),
            ...(typeof gender !==
            "undefined"
              ? { gender }
              : {}),
            ...(typeof dateOfBirth !==
            "undefined"
              ? {
                  dateOfBirth: dateOfBirth
                    ? new Date(
                        dateOfBirth
                      )
                    : null,
                }
              : {}),
            ...(normalizedEmail !== undefined
              ? { email: normalizedEmail }
              : {}),
          };

          const profileCreateData: Prisma.UserProfileUncheckedCreateInput =
            {
              userId,
              fullName:
                normalizedFullName ??
                existingProfile?.fullName ??
                "SewaGuru Customer",
              gender:
                typeof gender !==
                "undefined"
                  ? gender
                  : null,
              dateOfBirth:
                typeof dateOfBirth !==
                "undefined"
                  ? dateOfBirth
                    ? new Date(
                        dateOfBirth
                      )
                    : null
                  : null,
              ...(normalizedEmail !== undefined
                ? {
                    email:
                      normalizedEmail,
                  }
                : {}),
            };

          const saved =
            await tx.userProfile.upsert({
              where: { userId },
              update: profileUpdateData,
              create: profileCreateData,
            });

          if (normalizedEmail !== undefined) {
            const existingEmailAuth =
              await tx.userAuth.findFirst({
                where: {
                  userId,
                  provider: "GUEST",
                  identifierType: "EMAIL",
                },
              });

            const emailChanged =
              normalizedEmail !== previousEmail;

            // Clear any previous verification token only when email actually changes/clears.
            if (emailChanged) {
              await tx.emailVerificationToken.deleteMany(
                {
                  where: { userId },
                }
              );
            }

            if (!normalizedEmail) {
              if (existingEmailAuth) {
                await tx.userAuth.delete({
                  where: { id: existingEmailAuth.id },
                });
              }
            } else if (existingEmailAuth) {
              if (
                existingEmailAuth.identifier !==
                normalizedEmail
              ) {
                await tx.userAuth.update({
                  where: {
                    id: existingEmailAuth.id,
                  },
                  data: {
                    identifier: normalizedEmail,
                    isVerified: false,
                    isPrimary: false,
                  },
                });
              }
            } else {
              await tx.userAuth.create({
                data: {
                  userId,
                  provider: "GUEST",
                  identifierType: "EMAIL",
                  identifier: normalizedEmail,
                  isVerified: false,
                  isPrimary: false,
                },
              });
            }
          }

          if (normalizedPhone !== undefined) {
            const existingPhoneAuth =
              await tx.userAuth.findFirst({
                where: {
                  userId,
                  provider: "GUEST",
                  identifierType: "PHONE",
                },
              });

            if (!normalizedPhone) {
              if (existingPhoneAuth) {
                await tx.userAuth.delete({
                  where: {
                    id: existingPhoneAuth.id,
                  },
                });
              }
            } else if (existingPhoneAuth) {
              if (
                existingPhoneAuth.identifier !==
                normalizedPhone
              ) {
                await tx.userAuth.update({
                  where: {
                    id: existingPhoneAuth.id,
                  },
                  data: {
                    identifier:
                      normalizedPhone,
                    isVerified: false,
                    isPrimary: false,
                  },
                });
              }
            } else {
              await tx.userAuth.create({
                data: {
                  userId,
                  provider: "GUEST",
                  identifierType: "PHONE",
                  identifier:
                    normalizedPhone,
                  isVerified: false,
                  isPrimary: false,
                },
              });
            }
          }

          return saved;
        }
      )
      .catch((error) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          console.error("[PROFILE][UPDATE][PRISMA_ERROR]", {
            userId,
            code: error.code,
            meta: error.meta,
          });
        } else {
          console.error("[PROFILE][UPDATE][ERROR]", {
            userId,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          });
        }

        if (
          error instanceof
            Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          if (
            normalizedPhone !==
              undefined &&
            normalizedEmail ===
              undefined
          ) {
            throw new AppError(
              "Phone number already in use",
              400,
              "PHONE_IN_USE"
            );
          }

          throw new AppError(
            "Email already in use",
            400,
            "EMAIL_IN_USE"
          );
        }

        throw error;
      });

    clearUserCache(userId);

    //////////////////////////////////////////////////
    // RETURN FULL PROFILE SHAPE (CONSISTENT WITH GET)
    //////////////////////////////////////////////////

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        authMethods: true,
        addresses: {
          where: { isActive: true },
          orderBy: { isPrimary: "desc" },
        },
      },
    });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    const { phone, email: authEmail } =
      extractIdentifiers(user.authMethods);

    // Normalize possible legacy empty-string values to null.
    const profileEmail = user.profile?.email?.trim() || null;

    const resolvedEmail = profileEmail ?? authEmail;

    const emailAuthRecord = resolvedEmail
      ? user.authMethods.find(
          (a) =>
            a.identifierType === "EMAIL" &&
            a.provider === "GUEST" &&
            a.identifier === resolvedEmail
        ) ?? null
      : null;

    const formatted = {
      id: user.id,
      role: user.role,
      createdAt: user.createdAt,

      phone,
      email: resolvedEmail,
      isEmailVerified:
        emailAuthRecord?.isVerified ?? false,

      fullName:
        user.profile?.fullName ?? null,

      gender:
        user.profile?.gender ?? null,

      dateOfBirth:
        user.profile?.dateOfBirth ?? null,

      profileImage:
        user.profile?.profileImageUrl ??
        null,

      deletionStatus:
        user.deletionStatus,
      deletionRequestedAt:
        user.deletionRequestedAt,
      deletionScheduledFor:
        user.deletionScheduledFor,
      deletionCancelledAt:
        user.deletionCancelledAt,
      deletionCompletedAt:
        user.deletionCompletedAt,

      addresses: user.addresses,
    };

    console.log("[PROFILE][UPDATE_OK]", {
      userId,
      email: formatted.email ?? null,
    });

    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );
    res.setHeader("Pragma", "no-cache");

    res.json(
      successResponse(
        formatted,
        "Profile updated successfully"
      )
    );
  }
);

//////////////////////////////////////////////////////
// DELETE OWN ACCOUNT (APP)
//////////////////////////////////////////////////////

export const deleteOwnAccount =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {
      throw new AppError(
        "Please verify the delete OTP before deleting your account.",
        400,
        "DELETE_OTP_REQUIRED"
      );
    }
  );

//////////////////////////////////////////////////////
// DELETE ACCOUNT OTP
//////////////////////////////////////////////////////

export const sendDeleteAccountOtp =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {
      const userId =
        (req as any).user?.id;
      const requestedChannel =
        req.body?.channel === "PHONE" ||
        req.body?.channel === "EMAIL"
          ? req.body.channel
          : undefined;

      if (!userId) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      const user =
        await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            role: true,
            isActive: true,
            deletedAt: true,
            deletionStatus: true,
            authMethods: {
              select: {
                identifierType: true,
                identifier: true,
                isVerified: true,
                isPrimary: true,
              },
            },
          },
        });

      if (!user) {
        throw new AppError(
          "User not found",
          404
        );
      }

      if (
        user.role !== Role.USER
      ) {
        throw new AppError(
          "Please contact a super admin to remove admin accounts.",
          403,
          "ACCOUNT_DELETE_NOT_ALLOWED"
        );
      }

      if (
        user.deletionStatus ===
        "REQUESTED"
      ) {
        throw new AppError(
          "Account deletion is already scheduled.",
          409,
          "ACCOUNT_DELETION_ALREADY_REQUESTED"
        );
      }

      if (
        !user.isActive ||
        user.deletedAt
      ) {
        throw new AppError(
          "Account is already scheduled for deletion.",
          409,
          "ACCOUNT_ALREADY_DELETED"
        );
      }

      const target =
        resolveDeleteOtpTarget(
          user.authMethods as Array<{
            identifierType: "PHONE" | "EMAIL";
            identifier: string;
            isVerified: boolean;
            isPrimary: boolean;
          }>,
          requestedChannel
        );

      await createOTP(
        target.identifier,
        target.channel,
        "ACCOUNT_DELETE"
      );

      res.json(
        successResponse(
          null,
          "Delete OTP sent successfully.",
          {
            channel: target.channel,
            sentTo:
              maskDeleteOtpDestination(
                target.identifier,
                target.channel
              ),
          }
        )
      );
    }
  );

export const confirmDeleteOwnAccount =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {
      const userId =
        (req as any).user?.id;
      const otp =
        typeof req.body?.otp ===
        "string"
          ? req.body.otp.trim()
          : "";
      const requestedChannel =
        req.body?.channel === "PHONE" ||
        req.body?.channel === "EMAIL"
          ? req.body.channel
          : undefined;

      if (!userId) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      if (otp.length !== 6) {
        throw new AppError(
          "Enter the 6-digit OTP to continue.",
          400,
          "DELETE_OTP_REQUIRED"
        );
      }

      const user =
        await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            role: true,
            isActive: true,
            deletedAt: true,
            deletionStatus: true,
            authMethods: {
              select: {
                identifierType: true,
                identifier: true,
                isVerified: true,
                isPrimary: true,
              },
            },
          },
        });

      if (!user) {
        throw new AppError(
          "User not found",
          404
        );
      }

      if (
        user.role !== Role.USER
      ) {
        throw new AppError(
          "Please contact a super admin to remove admin accounts.",
          403,
          "ACCOUNT_DELETE_NOT_ALLOWED"
        );
      }

      if (
        user.deletionStatus ===
        "REQUESTED"
      ) {
        throw new AppError(
          "Account deletion is already scheduled.",
          409,
          "ACCOUNT_DELETION_ALREADY_REQUESTED"
        );
      }

      if (
        !user.isActive ||
        user.deletedAt
      ) {
        throw new AppError(
          "Account is already scheduled for deletion.",
          409,
          "ACCOUNT_ALREADY_DELETED"
        );
      }

      const target =
        resolveDeleteOtpTarget(
          user.authMethods as Array<{
            identifierType: "PHONE" | "EMAIL";
            identifier: string;
            isVerified: boolean;
            isPrimary: boolean;
          }>,
          requestedChannel
        );

      const verification =
        await verifyOTP({
          identifier:
            target.identifier,
          identifierType:
            target.channel,
          otp,
          type: "ACCOUNT_DELETE",
        });

      if (!verification.valid) {
        throw new AppError(
          "Invalid or expired OTP. Please request a new code and try again.",
          400,
          "DELETE_OTP_INVALID"
        );
      }

      await requestAccountDeletion({
        userId: user.id,
        reason:
          AccountDeletionReason.OTHER,
        feedback:
          "Requested through the legacy OTP delete-account flow.",
        requestIp:
          req.ip ||
          req.socket.remoteAddress ||
          null,
        requestedDevice:
          req.get("user-agent") ??
          null,
      });

      clearAuthCookie(res);

      res.json(
        successResponse(
          null,
          "Account deletion scheduled. Logging in again within 30 days will cancel this request."
        )
      );
    }
  );

//////////////////////////////////////////////////////
// DASHBOARD PROFILE
//////////////////////////////////////////////////////

export const getDashboardProfile =
  catchAsync(
    async (req: Request, res: Response) => {

      const userId =
        (req as any).user.id;

      const user =
        await prisma.user.findUnique({
          where: { id: userId },
          include: {
            authMethods: true,
            adminBranches: {
              include: {
                branch: {
                  include: {
                    city: true,
                  },
                },
              },
            },
          },
        });

      if (!user)
        throw new AppError(
          "User not found",
          404
        );

      const { phone, email } =
        extractIdentifiers(
          user.authMethods
        );

      res.json(
        successResponse({
          id: user.id,
          role: user.role,
          phone,
          email,
          branches:
            user.adminBranches,
        })
      );
    }
  );

//////////////////////////////////////////////////////
// SEND EMAIL VERIFICATION
//////////////////////////////////////////////////////

export const sendEmailVerification =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {

      const userId =
        (req as any).user.id;

      const result =
        await generateAndSendVerification(
          userId
        );

      res.setHeader(
        "Cache-Control",
        "no-store, max-age=0"
      );
      res.setHeader("Pragma", "no-cache");

      res.json(
        successResponse(
          null,
          "Verification email sent",
          result?.sentTo
            ? {
                sentTo: result.sentTo,
                provider: config.EMAIL_PROVIDER,
              }
            : undefined
        )
      );
    }
  );

//////////////////////////////////////////////////////
// VERIFY EMAIL
//////////////////////////////////////////////////////

export const verifyEmail =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {

      const token =
        req.query.token;

      if (
        !token ||
        typeof token !== "string"
      )
        throw new AppError(
          "Invalid token",
          400,
          "EMAIL_TOKEN_INVALID"
        );

      await verifyEmailToken(
        token
      );

      res.json(
        successResponse(
          null,
          "Email verified successfully"
        )
      );
    }
  );

  //////////////////////////////////////////////////////
// GET ALL ADMIN USERS
//////////////////////////////////////////////////////
export const getAllAdmins = catchAsync(
  async (req: Request, res: Response) => {
    const {
      search,
      page = "1",
      pageSize = "20",
    } = req.query as {
      search?: string;
      page?: string;
      pageSize?: string;
    };

    const pageNum = Math.max(
      1,
      Number(page) || 1
    );
    const limit = Math.min(
      Math.max(
        1,
        Number(pageSize) || 20
      ),
      100
    );
    const skip = (pageNum - 1) * limit;

    const q =
      typeof search === "string"
        ? search.trim()
        : "";

    const where: Prisma.UserWhereInput =
      {
        role: {
          in: [
            Role.ADMIN,
            Role.BRANCH_ADMIN,
          ],
        },
        isActive: true,
        isBlocked: false,
        ...(q
          ? {
              OR: [
                {
                  profile: {
                    fullName: {
                      contains: q,
                      mode: "insensitive",
                    },
                  },
                },
                {
                  profile: {
                    email: {
                      contains: q,
                      mode: "insensitive",
                    },
                  },
                },
                {
                  authMethods: {
                    some: {
                      identifier: {
                        contains: q,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      };

    const [total, admins] =
      await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          include: {
            profile: true,
            authMethods: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        }),
      ]);

    const formatted = admins.map(
      (user) => {
        const { phone, email } =
          extractIdentifiers(
            user.authMethods
          );

        return {
          id: user.id,
          role: user.role,
          fullName:
            user.profile?.fullName ??
            null,
          email,
          phone,
          createdAt: user.createdAt,
        };
      }
    );

    res.json(
      successResponse(
        formatted,
        "Admins fetched successfully",
        {
          page: pageNum,
          pageSize: limit,
          total,
          totalPages: Math.ceil(
            total / limit
          ),
        }
      )
    );
  }
);

export const getAllUsers = catchAsync(
  async (req: Request, res: Response) => {
    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );
    res.setHeader("Pragma", "no-cache");

    const {
      search,
      role,
      accountStatus,
      from,
      to,
      page = "1",
      pageSize = "20",
    } = req.query as {
      search?: string;
      role?: string;
      accountStatus?: string;
      from?: string;
      to?: string;
      page?: string;
      pageSize?: string;
    };

    const pageNum = Math.max(
      1,
      Number(page) || 1
    );

    const limit = Math.min(
      Math.max(
        1,
        Number(pageSize) || 20
      ),
      100
    );

    const skip = (pageNum - 1) * limit;

    const q =
      typeof search === "string"
        ? search.trim()
        : "";

    const where: Prisma.UserWhereInput =
      {
        isActive: true,
        ...(q
          ? {
              OR: [
                {
                  profile: {
                    fullName: {
                      contains: q,
                      mode: "insensitive",
                    },
                  },
                },
                {
                  profile: {
                    email: {
                      contains: q,
                      mode: "insensitive",
                    },
                  },
                },
                {
                  authMethods: {
                    some: {
                      identifier: {
                        contains: q,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      };

    const fromDate =
      parseUserFilterDate(from);
    const toDate =
      parseUserFilterDate(to, true);

    if (fromDate || toDate) {
      where.createdAt = {
        ...(fromDate
          ? { gte: fromDate }
          : {}),
        ...(toDate
          ? { lte: toDate }
          : {}),
      };
    }

    if (
      typeof role === "string" &&
      role.trim().length > 0
    ) {
      const trimmed =
        role.trim() as Role;
      if (
        !Object.values(Role).includes(
          trimmed
        )
      ) {
        throw new AppError(
          "Invalid role",
          400
        );
      }

      where.role = trimmed;
    }

    if (
      typeof accountStatus === "string" &&
      accountStatus.trim().length > 0
    ) {
      const normalizedStatus =
        accountStatus
          .trim()
          .toUpperCase();

      if (
        normalizedStatus !== "ACTIVE" &&
        normalizedStatus !== "BLOCKED"
      ) {
        throw new AppError(
          "Invalid account status",
          400
        );
      }

      where.isBlocked =
        normalizedStatus === "BLOCKED";
    }

    const summaryWhere: Prisma.UserWhereInput =
      {
        isActive: true,
        ...(q
          ? {
              OR: [
                {
                  profile: {
                    fullName: {
                      contains: q,
                      mode: "insensitive",
                    },
                  },
                },
                {
                  profile: {
                    email: {
                      contains: q,
                      mode: "insensitive",
                    },
                  },
                },
                {
                  authMethods: {
                    some: {
                      identifier: {
                        contains: q,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              ],
            }
          : {}),
        ...(fromDate || toDate
          ? {
              createdAt: {
                ...(fromDate
                  ? { gte: fromDate }
                  : {}),
                ...(toDate
                  ? { lte: toDate }
                  : {}),
              },
            }
          : {}),
      };

    const recentThreshold = new Date();
    recentThreshold.setDate(
      recentThreshold.getDate() - 30
    );

    const [
      total,
      users,
      totalUsers,
      activeUsers,
      blockedUsers,
      customerUsers,
      adminUsers,
      recentUsers,
    ] =
      await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          include: {
            profile: true,
            authMethods: true,
            _count: {
              select: {
                adminBranches: true,
                bookings: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        }),
        prisma.user.count({
          where: summaryWhere,
        }),
        prisma.user.count({
          where: {
            ...summaryWhere,
            isBlocked: false,
          },
        }),
        prisma.user.count({
          where: {
            ...summaryWhere,
            isBlocked: true,
          },
        }),
        prisma.user.count({
          where: {
            ...summaryWhere,
            role: Role.USER,
          },
        }),
        prisma.user.count({
          where: {
            ...summaryWhere,
            role: {
              in: [
                Role.ADMIN,
                Role.BRANCH_ADMIN,
                Role.SUPER_ADMIN,
              ],
            },
          },
        }),
        prisma.user.count({
          where: combineUserWhere(
            summaryWhere,
            {
              createdAt: {
                gte: recentThreshold,
              },
            }
          ),
        }),
      ]);

    const userIds = users.map(
      (user) => user.id
    );

    const [
      bookingStats,
      paidBookingStats,
    ] = userIds.length
      ? await Promise.all([
          prisma.booking.groupBy({
            by: ["userId"],
            where: {
              userId: { in: userIds },
            },
            _count: { _all: true },
            _max: { createdAt: true },
          }),
          prisma.booking.groupBy({
            by: ["userId"],
            where: {
              userId: { in: userIds },
              paymentStatus:
                PaymentStatus.PAID,
            },
            _sum: {
              totalAmount: true,
            },
          }),
        ])
      : [[], []];

    const bookingStatsMap = new Map(
      bookingStats.map((row) => [
        row.userId,
        row,
      ])
    );
    const paidBookingStatsMap =
      new Map(
        paidBookingStats.map((row) => [
          row.userId,
          row,
        ])
      );

    const formatted = users.map(
      (u) => {
        const { phone, email } =
          extractIdentifiers(
            u.authMethods
          );
        const bookingStat =
          bookingStatsMap.get(u.id);
        const paidBookingStat =
          paidBookingStatsMap.get(
            u.id
          );

        return {
          id: u.id,
          role: u.role,
          isBlocked: u.isBlocked,
          isActive: u.isActive,
          deletionStatus:
            u.deletionStatus,
          deletionRequestedAt:
            u.deletionRequestedAt,
          deletionScheduledFor:
            u.deletionScheduledFor,
          phone,
          email,
          fullName:
            u.profile?.fullName ??
            null,
          createdAt: u.createdAt,
          adminBranchesCount:
            u._count.adminBranches,
          bookingsCount:
            u._count.bookings,
          lastBookingAt:
            bookingStat?._max.createdAt ??
            null,
          totalSpent:
            paidBookingStat?._sum
              .totalAmount ?? 0,
        };
      }
    );

    res.json(
      successResponse(
        formatted,
        "Users fetched",
        {
          page: pageNum,
          pageSize: limit,
          total,
          totalPages: Math.ceil(
            total / limit
          ),
          summary: {
            totalUsers,
            activeUsers,
            blockedUsers,
            customerUsers,
            adminUsers,
            recentUsers,
          },
        }
      )
    );
  }
);

export const updateUserRole = catchAsync(
  async (req: Request, res: Response) => {

    const id = req.params.id;

    //////////////////////////////////////////////////
    // TYPE SAFE PARAM VALIDATION
    //////////////////////////////////////////////////
    if (!id || Array.isArray(id)) {
      throw new AppError(
        "Invalid user id",
        400
      );
    }

    const { role } = req.body as {
      role?: Role;
    };

    if (!role || !Object.values(Role).includes(role)) {
      throw new AppError(
        "Invalid role",
        400
      );
    }

    const actor = (req as any).user as {
      id: string;
      role: Role;
    };

    const targetUser =
      await prisma.user.findFirst({
        where: {
          id,
          isActive: true,
        },
        select: {
          id: true,
          role: true,
        },
      });

    if (!targetUser) {
      throw new AppError(
        "User not found",
        404
      );
    }

    const actorIsSuperAdmin =
      actor?.role === Role.SUPER_ADMIN;

    if (!actorIsSuperAdmin) {
      if (
        targetUser.role ===
          Role.SUPER_ADMIN ||
        role === Role.SUPER_ADMIN
      ) {
        throw new AppError(
          "Forbidden",
          403
        );
      }
    }

    await prisma.user.update({
      where: { id },
      data: { role },
    });

    res.json(
      successResponse(
        null,
        "Role updated"
      )
    );
  }
);


export const toggleUserBlock = catchAsync(
  async (req: Request, res: Response) => {

    const id = req.params.id;

    //////////////////////////////////////////////////
    // SAFE PARAM CHECK
    //////////////////////////////////////////////////
    if (!id || Array.isArray(id)) {
      throw new AppError(
        "Invalid user id",
        400
      );
    }

    const user =
      await prisma.user.findFirst({
        where: {
          id,
          isActive: true,
        },
      });

    if (!user)
      throw new AppError(
        "User not found",
        404
      );

    const actor = (req as any).user as {
      role: Role;
    };

    if (
      actor?.role !== Role.SUPER_ADMIN &&
      user.role === Role.SUPER_ADMIN
    ) {
      throw new AppError(
        "Forbidden",
        403
      );
    }

    await prisma.user.update({
      where: { id },
      data: {
        isBlocked: !user.isBlocked,
      },
    });

    res.json(
      successResponse(
        null,
        user.isBlocked
          ? "User unblocked"
          : "User blocked"
      )
    );
  }
);

export const archiveUser = catchAsync(
  async (req: Request, res: Response) => {
    const id = req.params.id;

    if (!id || Array.isArray(id)) {
      throw new AppError(
        "Invalid user id",
        400
      );
    }

    const actor = (req as any).user as {
      id: string;
      role: Role;
    };

    if (actor?.id === id) {
      throw new AppError(
        "You cannot delete your own account from the dashboard",
        409
      );
    }

    const user =
      await prisma.user.findFirst({
        where: {
          id,
          isActive: true,
          deletedAt: null,
        },
        select: {
          id: true,
          role: true,
        },
      });

    if (!user) {
      throw new AppError(
        "User not found",
        404
      );
    }

    const actorIsSuperAdmin =
      actor?.role === Role.SUPER_ADMIN;

    if (!actorIsSuperAdmin) {
      if (user.role === Role.SUPER_ADMIN) {
        throw new AppError(
          "Forbidden",
          403
        );
      }
    }

    await moveUserToTrash(user.id);

    res.json(
      successResponse(
        null,
        "User moved to trash. It will be permanently deleted after 30 days unless restored."
      )
    );
  }
);

//////////////////////////////////////////////////////
// GET USER BY ID (DASHBOARD)
//////////////////////////////////////////////////////
//////////////////////////////////////////////////////
// GET USER FULL DETAILS (DASHBOARD)
//////////////////////////////////////////////////////

export const getUserById = catchAsync(
  async (req: Request, res: Response) => {

    //////////////////////////////////////////////////
    // PARAM VALIDATION
    //////////////////////////////////////////////////
    const id = req.params.id;

    if (!id || Array.isArray(id)) {
      throw new AppError(
        "Invalid user id",
        400
      );
    }

    //////////////////////////////////////////////////
    // FETCH COMPLETE USER
    //////////////////////////////////////////////////
    const user = await prisma.user.findFirst({
      where: {
        id,
        isActive: true,
        deletedAt: null,
      },

      include: {

        //////////////////////////////////////////////////
        // PROFILE
        //////////////////////////////////////////////////
        profile: true,

        //////////////////////////////////////////////////
        // LOGIN METHODS
        //////////////////////////////////////////////////
        authMethods: true,

        //////////////////////////////////////////////////
        // ADDRESSES
        //////////////////////////////////////////////////
        addresses: {
          where: { isActive: true },
          include: {
            city: true,
          },
          orderBy: {
            isPrimary: "desc",
          },
        },

        //////////////////////////////////////////////////
        // ADMIN BRANCHES
        //////////////////////////////////////////////////
        adminBranches: {
          include: {
            branch: {
              include: {
                city: true,
              },
            },
          },
        },

        //////////////////////////////////////////////////
        // CUSTOMER IDENTITIES
        //////////////////////////////////////////////////
        identities: true,

        //////////////////////////////////////////////////
        // EMAIL TOKEN
        //////////////////////////////////////////////////
        emailVerificationToken: true,
      },
    });

    if (!user) {
      throw new AppError(
        "User not found",
        404
      );
    }

    //////////////////////////////////////////////////
    // IDENTIFIERS
    //////////////////////////////////////////////////
    const { phone, email } =
      extractIdentifiers(
        user.authMethods
      );

    //////////////////////////////////////////////////
    // FORMAT RESPONSE
    //////////////////////////////////////////////////
      const formatted = {
        id: user.id,

      role: user.role,
      isActive: user.isActive,
      isBlocked: user.isBlocked,
      deletionStatus:
        user.deletionStatus,
      deletionReason:
        user.deletionReason,
      deletionFeedback:
        user.deletionFeedback,
      deletionRequestedAt:
        user.deletionRequestedAt,
      deletionScheduledFor:
        user.deletionScheduledFor,
      deletionCancelledAt:
        user.deletionCancelledAt,
      deletionCompletedAt:
        user.deletionCompletedAt,
      cancelledByLogin:
        user.cancelledByLogin,

      totalBookings:
        user.totalBookings,

      lastActiveAt:
        user.lastActiveAt,

      createdAt: user.createdAt,

      //////////////////////////////////////////////////
      // PROFILE
      //////////////////////////////////////////////////
      profile: {
        fullName:
          user.profile?.fullName ??
          null,

        gender:
          user.profile?.gender ??
          null,

        profileImage:
          user.profile
            ?.profileImageUrl ??
          null,

        dateOfBirth:
          user.profile
            ?.dateOfBirth ??
          null,
      },

      //////////////////////////////////////////////////
      // CONTACT
      //////////////////////////////////////////////////
      phone,
      email,

      //////////////////////////////////////////////////
      // AUTH METHODS
      //////////////////////////////////////////////////
      authMethods:
        user.authMethods.map(a => ({
          provider: a.provider,
          type: a.identifierType,
          identifier: a.identifier,
          verified: a.isVerified,
          primary: a.isPrimary,
        })),

      //////////////////////////////////////////////////
      // ADDRESSES
      //////////////////////////////////////////////////
      addresses:
        user.addresses,

      //////////////////////////////////////////////////
      // ADMIN ACCESS
      //////////////////////////////////////////////////
      branches:
        user.adminBranches.map(
          ab => ({
            branchId:
              ab.branch.id,
            branchName:
              ab.branch.name,
            city:
              ab.branch.city.name,
            state:
              ab.branch.city.state,
            isHead:
              ab.isHead,
            assignedAt:
              ab.assignedAt,
          })
        ),

      //////////////////////////////////////////////////
      // IDENTITIES
      //////////////////////////////////////////////////
      identities:
        user.identities,

        //////////////////////////////////////////////////
        // EMAIL VERIFIED
        //////////////////////////////////////////////////
        emailVerificationPending:
          !!user.emailVerificationToken,

        //////////////////////////////////////////////////
        // STATS (BOOKINGS, SPEND, DISCOUNTS)
        //////////////////////////////////////////////////
        stats: undefined as any,

        //////////////////////////////////////////////////
        // COUPONS / OFFERS USED
        //////////////////////////////////////////////////
        couponsUsed: [] as any[],
        offersUsed: [] as any[],
      };

      const [
        allBookingsAgg,
        paidBookingsAgg,
        couponGroups,
        offerGroups,
        paymentOrdersCount,
      ] = await Promise.all([
        prisma.booking.aggregate({
          where: {
            userId: user.id,
            isActive: true,
          },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        prisma.booking.aggregate({
          where: {
            userId: user.id,
            isActive: true,
            paymentStatus: "PAID",
          },
          _count: { _all: true },
          _sum: {
            totalAmount: true,
            discountAmount: true,
            taxAmount: true,
            subtotal: true,
          },
        }),
        prisma.booking.groupBy({
          by: ["couponId"],
          where: {
            userId: user.id,
            isActive: true,
            couponId: { not: null },
          },
          _count: { _all: true },
          _sum: { discountAmount: true },
        }),
        prisma.booking.groupBy({
          by: ["offerId"],
          where: {
            userId: user.id,
            isActive: true,
            offerId: { not: null },
          },
          _count: { _all: true },
          _sum: { discountAmount: true },
        }),
        prisma.paymentOrder.count({
          where: {
            booking: {
              userId: user.id,
              isActive: true,
            },
          },
        }),
      ]);

      const couponIds =
        couponGroups
          .map((g) => g.couponId)
          .filter(
            (id): id is string =>
              typeof id === "string" &&
              id.length > 0
          );

      const offerIds =
        offerGroups
          .map((g) => g.offerId)
          .filter(
            (id): id is string =>
              typeof id === "string" &&
              id.length > 0
          );

      const [coupons, offers] =
        await Promise.all([
          couponIds.length
            ? prisma.coupon.findMany({
                where: {
                  id: { in: couponIds },
                },
                select: {
                  id: true,
                  code: true,
                  title: true,
                },
              })
            : Promise.resolve([]),
          offerIds.length
            ? prisma.offer.findMany({
                where: {
                  id: { in: offerIds },
                },
                select: {
                  id: true,
                  title: true,
                  badge: true,
                },
              })
            : Promise.resolve([]),
        ]);

      const couponMap = new Map(
        coupons.map((c) => [c.id, c])
      );
      const offerMap = new Map(
        offers.map((o) => [o.id, o])
      );

      const couponsUsed = couponGroups
        .map((g) => {
          const id = g.couponId as string;
          const c = couponMap.get(id);
          return {
            couponId: id,
            code: c?.code ?? null,
            title: c?.title ?? null,
            count: g._count._all,
            totalDiscount:
              g._sum.discountAmount ?? 0,
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);

      const offersUsed = offerGroups
        .map((g) => {
          const id = g.offerId as string;
          const o = offerMap.get(id);
          return {
            offerId: id,
            title: o?.title ?? null,
            badge: o?.badge ?? null,
            count: g._count._all,
            totalDiscount:
              g._sum.discountAmount ?? 0,
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);

      formatted.stats = {
        bookingsTotal:
          allBookingsAgg._count._all,
        bookingsPaid:
          paidBookingsAgg._count._all,
        totalSpent:
          paidBookingsAgg._sum.totalAmount ??
          0,
        totalDiscount:
          paidBookingsAgg._sum
            .discountAmount ?? 0,
        totalTax:
          paidBookingsAgg._sum.taxAmount ??
          0,
        lastBookingAt:
          allBookingsAgg._max.createdAt ??
          null,
        paymentOrdersCount,
      };

      formatted.couponsUsed = couponsUsed;
      formatted.offersUsed = offersUsed;

    res.json(
      successResponse(
        formatted,
        "User details fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// USER PAYMENT ORDERS (DASHBOARD)
//////////////////////////////////////////////////////

export const getUserPaymentOrders =
  catchAsync(
    async (req: Request, res: Response) => {
      const id = req.params.id;

      if (!id || Array.isArray(id)) {
        throw new AppError(
          "Invalid user id",
          400
        );
      }

      const {
        page = "1",
        pageSize = "20",
      } = req.query as {
        page?: string;
        pageSize?: string;
      };

      const pageNum = Math.max(
        1,
        Number(page) || 1
      );

      const limit = Math.min(
        Math.max(
          1,
          Number(pageSize) || 20
        ),
        100
      );

      const skip = (pageNum - 1) * limit;

      const where: Prisma.PaymentOrderWhereInput =
        {
          booking: { userId: id },
        };

      const [total, rows] =
        await Promise.all([
          prisma.paymentOrder.count({
            where,
          }),
          prisma.paymentOrder.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: "desc" },
            include: {
              booking: {
                select: {
                  id: true,
                  displayId: true,
                  status: true,
                  paymentStatus: true,
                  totalAmount: true,
                  createdAt: true,
                },
              },
            },
          }),
        ]);

      const formatted = rows.map(
        (row) => ({
          id: row.id,
          bookingId: row.bookingId,
          booking: row.booking,
          gateway: row.gateway,
          providerOrderId:
            row.providerOrderId,
          merchantOrderId:
            row.merchantOrderId,
          state: row.state,
          amountPaise: row.amount,
          amount: row.amount / 100,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
      );

      res.json(
        successResponse(
          formatted,
          "Payment orders fetched",
          {
            page: pageNum,
            pageSize: limit,
            total,
            totalPages: Math.ceil(
              total / limit
            ),
          }
        )
      );
    }
  );
