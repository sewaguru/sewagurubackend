import crypto from "crypto";
import {
  AccountDeletionReason,
  AccountDeletionStatus,
  AuthIdentifierType,
  Prisma,
  Role,
} from "../generated/prisma";
import { config } from "../config/config";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { clearUserCache } from "../utils/cache";

export const ACCOUNT_DELETION_GRACE_DAYS = 30;
export const ACCOUNT_DELETION_CANCELLED_MESSAGE =
  "Your account deletion request has been cancelled because you logged in again.";

const DELETION_FEEDBACK_MAX_LENGTH = 500;
const DELETION_DEVICE_MAX_LENGTH = 500;
const DELETION_IP_MAX_LENGTH = 120;
const DELETED_USER_DISPLAY_NAME = "Deleted User";

const accountDeletionSelect = {
  id: true,
  deletionRequestedAt: true,
  deletionScheduledFor: true,
  deletionCancelledAt: true,
  deletionCompletedAt: true,
  deletionStatus: true,
  deletionReason: true,
  deletionFeedback: true,
  deletionRequestIp: true,
  deletionRequestedDevice: true,
  cancelledByLogin: true,
  finalDeletionJobStatus: true,
  finalDeletionJobMetadata: true,
  finalDeletionAttemptedAt: true,
} satisfies Prisma.UserSelect;

type AccountDeletionSnapshot = Prisma.UserGetPayload<{
  select: typeof accountDeletionSelect;
}>;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const trimToNull = (
  value: unknown,
  maxLength: number
) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
};

const serializeStatus = (
  value: AccountDeletionSnapshot
) => ({
  status: value.deletionStatus,
  requestedAt: value.deletionRequestedAt,
  scheduledFor: value.deletionScheduledFor,
  cancelledAt: value.deletionCancelledAt,
  completedAt: value.deletionCompletedAt,
  reason: value.deletionReason,
  feedback: value.deletionFeedback,
  requestIp: value.deletionRequestIp,
  requestedDevice: value.deletionRequestedDevice,
  cancelledByLogin: value.cancelledByLogin,
  finalDeletionJobStatus: value.finalDeletionJobStatus,
  finalDeletionJobMetadata: value.finalDeletionJobMetadata,
  finalDeletionAttemptedAt: value.finalDeletionAttemptedAt,
  graceDays: ACCOUNT_DELETION_GRACE_DAYS,
});

export const hashDeletionIdentifier = ({
  identifier,
  identifierType,
}: {
  identifier: string;
  identifierType: AuthIdentifierType;
}) =>
  crypto
    .createHmac(
      "sha256",
      config.JWT_SECRET
    )
    .update(
      `${identifierType}:${identifier.trim().toLowerCase()}`
    )
    .digest("hex");

export const assertIdentifierNotPermanentlyDeleted =
  async ({
    identifier,
    identifierType,
  }: {
    identifier: string;
    identifierType: AuthIdentifierType;
  }) => {
    const identifierHash =
      hashDeletionIdentifier({
        identifier,
        identifierType,
      });

    const tombstone =
      await prisma.accountDeletionTombstone.findUnique(
        {
          where: { identifierHash },
          select: { id: true },
        }
      );

    if (tombstone) {
      throw new AppError(
        "This account has been permanently deleted.",
        410,
        "ACCOUNT_DELETED"
      );
    }
  };

export const getAccountDeletionStatus =
  async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: accountDeletionSelect,
    });

    if (!user) {
      throw new AppError(
        "User not found",
        404
      );
    }

    return serializeStatus(user);
  };

export const requestAccountDeletion =
  async ({
    userId,
    reason,
    feedback,
    requestIp,
    requestedDevice,
  }: {
    userId: string;
    reason: AccountDeletionReason;
    feedback?: string | null;
    requestIp?: string | null;
    requestedDevice?: string | null;
  }) => {
    const now = new Date();
    const scheduledFor = addDays(
      now,
      ACCOUNT_DELETION_GRACE_DAYS
    );

    const result = await prisma.$transaction(
      async (tx) => {
        const user =
          await tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              role: true,
              isActive: true,
              deletedAt: true,
              deletionStatus: true,
            },
          });

        if (!user) {
          throw new AppError(
            "User not found",
            404
          );
        }

        if (user.role !== Role.USER) {
          throw new AppError(
            "Please contact a super admin to remove admin accounts.",
            403,
            "ACCOUNT_DELETE_NOT_ALLOWED"
          );
        }

        if (
          user.deletionStatus ===
          AccountDeletionStatus.REQUESTED
        ) {
          throw new AppError(
            "Account deletion is already scheduled.",
            409,
            "ACCOUNT_DELETION_ALREADY_REQUESTED"
          );
        }

        if (
          user.deletionStatus ===
          AccountDeletionStatus.COMPLETED
        ) {
          throw new AppError(
            "This account has already been permanently deleted.",
            410,
            "ACCOUNT_DELETED"
          );
        }

        if (
          !user.isActive ||
          user.deletedAt
        ) {
          throw new AppError(
            "Account is not active.",
            409,
            "ACCOUNT_NOT_ACTIVE"
          );
        }

        await tx.deviceToken.deleteMany({
          where: { userId },
        });

        const updated =
          await tx.user.update({
            where: { id: userId },
            data: {
              deletionRequestedAt: now,
              deletionScheduledFor:
                scheduledFor,
              deletionCancelledAt: null,
              deletionCompletedAt: null,
              deletionStatus:
                AccountDeletionStatus.REQUESTED,
              deletionReason: reason,
              deletionFeedback:
                trimToNull(
                  feedback,
                  DELETION_FEEDBACK_MAX_LENGTH
                ),
              deletionRequestIp:
                trimToNull(
                  requestIp,
                  DELETION_IP_MAX_LENGTH
                ),
              deletionRequestedDevice:
                trimToNull(
                  requestedDevice,
                  DELETION_DEVICE_MAX_LENGTH
                ),
              cancelledByLogin: false,
              finalDeletionJobStatus: null,
              finalDeletionJobMetadata:
                Prisma.JsonNull,
              finalDeletionAttemptedAt: null,
            },
            select: accountDeletionSelect,
          });

        return updated;
      }
    );

    clearUserCache(userId);
    return serializeStatus(result);
  };

export const cancelAccountDeletion =
  async ({
    userId,
    cancelledByLogin = false,
  }: {
    userId: string;
    cancelledByLogin?: boolean;
  }) => {
    const now = new Date();

    const result = await prisma.$transaction(
      async (tx) => {
        const user =
          await tx.user.findUnique({
            where: { id: userId },
            select: {
              ...accountDeletionSelect,
              deletionStatus: true,
            },
          });

        if (!user) {
          throw new AppError(
            "User not found",
            404
          );
        }

        if (
          user.deletionStatus ===
          AccountDeletionStatus.COMPLETED
        ) {
          throw new AppError(
            "This account has already been permanently deleted.",
            410,
            "ACCOUNT_DELETED"
          );
        }

        if (
          user.deletionStatus !==
          AccountDeletionStatus.REQUESTED
        ) {
          return user;
        }

        return tx.user.update({
          where: { id: userId },
          data: {
            deletionStatus:
              AccountDeletionStatus.CANCELLED,
            deletionCancelledAt: now,
            cancelledByLogin,
            finalDeletionJobStatus: null,
            finalDeletionJobMetadata:
              Prisma.JsonNull,
            finalDeletionAttemptedAt: null,
          },
          select: accountDeletionSelect,
        });
      }
    );

    clearUserCache(userId);
    return serializeStatus(result);
  };

const sanitizeAddressSnapshot = (
  value: unknown
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (!isRecord(value)) {
    return Prisma.JsonNull;
  }

  const city = isRecord(value.city)
    ? {
        id:
          typeof value.city.id === "string"
            ? value.city.id
            : null,
        name:
          typeof value.city.name === "string"
            ? value.city.name
            : null,
        state:
          typeof value.city.state === "string"
            ? value.city.state
            : null,
        country:
          typeof value.city.country === "string"
            ? value.city.country
            : null,
      }
    : null;

  return {
    id:
      typeof value.id === "string"
        ? value.id
        : "deleted-address",
    label: "DELETED",
    customLabel: null,
    addressLine1: null,
    addressLine2: null,
    landmark: null,
    locality: null,
    pincode:
      typeof value.pincode === "string"
        ? value.pincode
        : null,
    latitude: null,
    longitude: null,
    placeId: null,
    contactName: null,
    contactPhone: null,
    city,
    state:
      typeof value.state === "string"
        ? value.state
        : null,
    country:
      typeof value.country === "string"
        ? value.country
        : null,
  };
};

const sanitizeCartSnapshot = (
  value: unknown
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (!isRecord(value)) {
    return Prisma.JsonNull;
  }

  const items = Array.isArray(value.items)
    ? value.items.map((item) =>
        isRecord(item)
          ? {
              ...item,
              bookingData: null,
            }
          : item
      )
    : [];

  return {
    ...value,
    address: sanitizeAddressSnapshot(
      value.address
    ),
    items,
  } as Prisma.InputJsonValue;
};

type FinalDeletionMode =
  | "SCHEDULED_JOB"
  | "LOGIN_AFTER_GRACE"
  | "ADMIN"
  | "TRASH_PURGE";

export const permanentlyAnonymizeUser =
  async ({
    userId,
    mode,
    requireDueRequest = false,
    now = new Date(),
  }: {
    userId: string;
    mode: FinalDeletionMode;
    requireDueRequest?: boolean;
    now?: Date;
  }) => {
    const result = await prisma.$transaction(
      async (tx) => {
        const user =
          await tx.user.findUnique({
            where: { id: userId },
            include: {
              authMethods: true,
              profile: true,
            },
          });

        if (!user) {
          throw new AppError(
            "User not found",
            404
          );
        }

        if (
          user.deletionStatus ===
          AccountDeletionStatus.COMPLETED
        ) {
          return {
            userId,
            skipped: true,
            reason:
              "Already completed",
            counts: {},
          };
        }

        if (requireDueRequest) {
          if (
            user.deletionStatus !==
            AccountDeletionStatus.REQUESTED
          ) {
            return {
              userId,
              skipped: true,
              reason:
                "Deletion request is no longer active",
              counts: {},
            };
          }

          if (
            !user.deletionScheduledFor ||
            user.deletionScheduledFor.getTime() >
              now.getTime()
          ) {
            return {
              userId,
              skipped: true,
              reason:
                "Deletion request is not due yet",
              counts: {},
            };
          }
        }

        await tx.user.update({
          where: { id: userId },
          data: {
            finalDeletionJobStatus:
              "PROCESSING",
            finalDeletionAttemptedAt:
              now,
          },
        });

        const tombstones =
          user.authMethods
            .map((method) => {
              const identifier =
                method.identifier?.trim();
              if (!identifier) {
                return null;
              }

              return {
                userId,
                identifierType:
                  method.identifierType,
                identifierHash:
                  hashDeletionIdentifier({
                    identifier,
                    identifierType:
                      method.identifierType,
                  }),
              };
            })
            .filter(
              (
                item
              ): item is {
                userId: string;
                identifierType: AuthIdentifierType;
                identifierHash: string;
              } => Boolean(item)
            );

        if (tombstones.length) {
          await tx.accountDeletionTombstone.createMany(
            {
              data: tombstones,
              skipDuplicates: true,
            }
          );
        }

        const identityRows =
          await tx.customerIdentity.findMany({
            where: { userId },
            select: { id: true },
          });
        const identityIds =
          identityRows.map(
            (identity) => identity.id
          );

        const bookings =
          await tx.booking.findMany({
            where: { userId },
            select: {
              id: true,
              addressSnapshot: true,
              cartSnapshot: true,
            },
          });

        for (const booking of bookings) {
          await tx.booking.update({
            where: { id: booking.id },
            data: {
              addressId: null,
              addressSnapshot:
                sanitizeAddressSnapshot(
                  booking.addressSnapshot
                ),
              cartSnapshot:
                sanitizeCartSnapshot(
                  booking.cartSnapshot
                ),
              notes: null,
            },
          });
        }

        const bookingItems =
          await tx.bookingItem.updateMany({
            where: {
              booking: { userId },
            },
            data: {
              inputData:
                Prisma.JsonNull,
            },
          });

        const identityAddresses =
          identityIds.length
            ? await tx.address.deleteMany({
                where: {
                  identityId: {
                    in: identityIds,
                  },
                },
              })
            : { count: 0 };

        const savedAddresses =
          await tx.address.deleteMany({
            where: { userId },
          });

        const identities =
          identityIds.length
            ? await tx.customerIdentity.updateMany({
                where: {
                  id: {
                    in: identityIds,
                  },
                },
                data: {
                  phone: null,
                  email: null,
                  userId: null,
                  isVerified: false,
                },
              })
            : { count: 0 };

        const [
          deviceTokens,
          carts,
          notifications,
          authMethods,
          emailTokens,
          deliveryLogs,
          reviews,
        ] = await Promise.all([
          tx.deviceToken.deleteMany({
            where: { userId },
          }),
          tx.cart.deleteMany({
            where: { userId },
          }),
          tx.notification.deleteMany({
            where: { userId },
          }),
          tx.userAuth.deleteMany({
            where: { userId },
          }),
          tx.emailVerificationToken.deleteMany({
            where: { userId },
          }),
          tx.notificationDeliveryLog.updateMany({
            where: { userId },
            data: {
              userId: null,
              recipient: null,
              payload:
                Prisma.JsonNull,
            },
          }),
          tx.serviceReview.updateMany({
            where: { userId },
            data: {
              comment: null,
              isVisible: false,
            },
          }),
        ]);

        await tx.userProfile.upsert({
          where: { userId },
          update: {
            fullName:
              DELETED_USER_DISPLAY_NAME,
            email: null,
            gender: null,
            profileImageUrl: null,
            dateOfBirth: null,
          },
          create: {
            userId,
            fullName:
              DELETED_USER_DISPLAY_NAME,
            email: null,
            gender: null,
            profileImageUrl: null,
            dateOfBirth: null,
          },
        });

        const metadata = {
          mode,
          completedAt: now.toISOString(),
          tombstonesCreated:
            tombstones.length,
          bookingSnapshotsSanitized:
            bookings.length,
          counts: {
            savedAddresses:
              savedAddresses.count,
            identityAddresses:
              identityAddresses.count,
            identities:
              identities.count,
            deviceTokens:
              deviceTokens.count,
            carts: carts.count,
            notifications:
              notifications.count,
            authMethods:
              authMethods.count,
            emailTokens:
              emailTokens.count,
            deliveryLogs:
              deliveryLogs.count,
            reviews: reviews.count,
            bookingItems:
              bookingItems.count,
          },
        };

        await tx.user.update({
          where: { id: userId },
          data: {
            isActive: false,
            isBlocked: true,
            deletedAt: now,
            scheduledPurgeAt: null,
            deletionStatus:
              AccountDeletionStatus.COMPLETED,
            deletionCompletedAt: now,
            finalDeletionJobStatus:
              "COMPLETED",
            finalDeletionJobMetadata:
              metadata,
            finalDeletionAttemptedAt:
              now,
          },
        });

        return {
          userId,
          skipped: false,
          reason: null,
          counts: metadata.counts,
        };
      },
      {
        timeout: 30_000,
      }
    );

    clearUserCache(userId);
    return result;
  };

export const resolveAccountDeletionOnLogin =
  async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        deletionStatus: true,
        deletionScheduledFor: true,
      },
    });

    if (!user) {
      throw new AppError(
        "User not found",
        404
      );
    }

    if (
      user.deletionStatus ===
      AccountDeletionStatus.COMPLETED
    ) {
      throw new AppError(
        "This account has been permanently deleted.",
        410,
        "ACCOUNT_DELETED"
      );
    }

    if (
      user.deletionStatus !==
      AccountDeletionStatus.REQUESTED
    ) {
      return {
        cancelled: false,
        message: null as string | null,
      };
    }

    const now = new Date();
    if (
      user.deletionScheduledFor &&
      user.deletionScheduledFor.getTime() <=
        now.getTime()
    ) {
      await permanentlyAnonymizeUser({
        userId,
        mode: "LOGIN_AFTER_GRACE",
        requireDueRequest: true,
        now,
      });

      throw new AppError(
        "This account has been permanently deleted.",
        410,
        "ACCOUNT_DELETED"
      );
    }

    await cancelAccountDeletion({
      userId,
      cancelledByLogin: true,
    });

    return {
      cancelled: true,
      message:
        ACCOUNT_DELETION_CANCELLED_MESSAGE,
    };
  };

let deletionJobLocked = false;

export const processDueAccountDeletions =
  async ({
    limit = config.ACCOUNT_DELETION_JOB_BATCH_SIZE,
    dryRun = false,
    now = new Date(),
  }: {
    limit?: number;
    dryRun?: boolean;
    now?: Date;
  } = {}) => {
    if (deletionJobLocked) {
      return {
        locked: true,
        dryRun,
        dueCount: 0,
        processed: [],
      };
    }

    deletionJobLocked = true;

    try {
      const batchSize = Math.min(
        Math.max(1, Math.floor(limit)),
        config.ACCOUNT_DELETION_JOB_BATCH_SIZE
      );

      const [dueCount, dueUsers] =
        await Promise.all([
          prisma.user.count({
            where: {
              deletionStatus:
                AccountDeletionStatus.REQUESTED,
              deletionScheduledFor: {
                lte: now,
              },
              deletionCompletedAt: null,
            },
          }),
          prisma.user.findMany({
            where: {
              deletionStatus:
                AccountDeletionStatus.REQUESTED,
              deletionScheduledFor: {
                lte: now,
              },
              deletionCompletedAt: null,
            },
            select: {
              id: true,
              deletionScheduledFor: true,
            },
            orderBy: {
              deletionScheduledFor: "asc",
            },
            take: batchSize,
          }),
        ]);

      if (dryRun) {
        return {
          locked: false,
          dryRun: true,
          dueCount,
          selectedCount:
            dueUsers.length,
          processed: dueUsers.map(
            (user) => ({
              userId: user.id,
              scheduledFor:
                user.deletionScheduledFor,
            })
          ),
        };
      }

      const processed: Array<{
        userId: string;
        status: "COMPLETED" | "SKIPPED" | "FAILED";
        reason?: string | null;
      }> = [];

      for (const user of dueUsers) {
        try {
          const result =
            await permanentlyAnonymizeUser({
              userId: user.id,
              mode: "SCHEDULED_JOB",
              requireDueRequest: true,
              now,
            });

          processed.push({
            userId: user.id,
            status: result.skipped
              ? "SKIPPED"
              : "COMPLETED",
            reason: result.reason,
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Final deletion failed.";

          await prisma.user
            .update({
              where: { id: user.id },
              data: {
                finalDeletionJobStatus:
                  "FAILED",
                finalDeletionAttemptedAt:
                  now,
                finalDeletionJobMetadata:
                  {
                    mode: "SCHEDULED_JOB",
                    failedAt:
                      now.toISOString(),
                    error: message,
                  },
              },
            })
            .catch((updateError) => {
              console.error(
                "[ACCOUNT_DELETION] Failed to record job failure",
                {
                  userId: user.id,
                  updateError,
                }
              );
            });

          processed.push({
            userId: user.id,
            status: "FAILED",
            reason: message,
          });
        }
      }

      return {
        locked: false,
        dryRun: false,
        dueCount,
        selectedCount:
          dueUsers.length,
        processed,
        safeguard: {
          batchSize,
          deferredCount:
            Math.max(
              0,
              dueCount - dueUsers.length
            ),
        },
      };
    } finally {
      deletionJobLocked = false;
    }
  };

export const startAccountDeletionJob = () => {
  const run = () => {
    void processDueAccountDeletions()
      .then((result) => {
        if (
          !result.dryRun &&
          "processed" in result &&
          Array.isArray(
            result.processed
          ) &&
          result.processed.length > 0
        ) {
          console.log(
            "[ACCOUNT_DELETION] Processed due account deletions.",
            result
          );
        }
      })
      .catch((error) => {
        console.error(
          "[ACCOUNT_DELETION] Failed to process due account deletions",
          error
        );
      });
  };

  run();

  const timer = setInterval(
    run,
    config.ACCOUNT_DELETION_JOB_INTERVAL_MS
  );

  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
};

export const listAccountDeletionRequests =
  async ({
    status,
    reason,
    from,
    to,
    page = 1,
    pageSize = 20,
  }: {
    status?: AccountDeletionStatus;
    reason?: AccountDeletionReason;
    from?: Date | null;
    to?: Date | null;
    page?: number;
    pageSize?: number;
  }) => {
    const where: Prisma.UserWhereInput = {
      deletionRequestedAt: {
        not: null,
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      },
      ...(status
        ? { deletionStatus: status }
        : {}),
      ...(reason
        ? { deletionReason: reason }
        : {}),
    };

    const [total, users] =
      await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: {
            deletionRequestedAt:
              "desc",
          },
          include: {
            profile: true,
            authMethods: true,
            _count: {
              select: {
                bookings: true,
              },
            },
          },
        }),
      ]);

    const rows = users.map((user) => {
      const phone =
        user.authMethods.find(
          (method) =>
            method.identifierType ===
            AuthIdentifierType.PHONE
        )?.identifier ?? null;
      const email =
        user.profile?.email ??
        user.authMethods.find(
          (method) =>
            method.identifierType ===
            AuthIdentifierType.EMAIL
        )?.identifier ??
        null;

      return {
        id: user.id,
        fullName:
          user.profile?.fullName ??
          null,
        email,
        phone,
        role: user.role,
        isActive: user.isActive,
        isBlocked: user.isBlocked,
        bookingsCount:
          user._count.bookings,
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
        deletionRequestIp:
          user.deletionRequestIp,
        deletionRequestedDevice:
          user.deletionRequestedDevice,
        finalDeletionJobStatus:
          user.finalDeletionJobStatus,
        finalDeletionJobMetadata:
          user.finalDeletionJobMetadata,
        finalDeletionAttemptedAt:
          user.finalDeletionAttemptedAt,
      };
    });

    return {
      data: rows,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(
          total / pageSize
        ),
      },
    };
  };

export const getAccountDeletionStats =
  async ({
    from,
    to,
  }: {
    from?: Date | null;
    to?: Date | null;
  } = {}) => {
    const requestedWhere: Prisma.UserWhereInput =
      {
        deletionRequestedAt: {
          not: null,
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      };

    const trendStart = new Date();
    trendStart.setMonth(
      trendStart.getMonth() - 11
    );
    trendStart.setDate(1);
    trendStart.setHours(0, 0, 0, 0);

    const [
      totalRequests,
      pendingDeletion,
      cancelledByLogin,
      completedDeletions,
      reasonGroups,
      statusGroups,
      trendRows,
    ] = await Promise.all([
      prisma.user.count({
        where: requestedWhere,
      }),
      prisma.user.count({
        where: {
          ...requestedWhere,
          deletionStatus:
            AccountDeletionStatus.REQUESTED,
        },
      }),
      prisma.user.count({
        where: {
          ...requestedWhere,
          deletionStatus:
            AccountDeletionStatus.CANCELLED,
          cancelledByLogin: true,
        },
      }),
      prisma.user.count({
        where: {
          ...requestedWhere,
          deletionStatus:
            AccountDeletionStatus.COMPLETED,
        },
      }),
      prisma.user.groupBy({
        by: ["deletionReason"],
        where: {
          ...requestedWhere,
          deletionReason: {
            not: null,
          },
        },
        _count: { _all: true },
        orderBy: {
          _count: {
            deletionReason: "desc",
          },
        },
      }),
      prisma.user.groupBy({
        by: ["deletionStatus"],
        where: requestedWhere,
        _count: { _all: true },
      }),
      prisma.user.findMany({
        where: {
          deletionRequestedAt: {
            gte: trendStart,
          },
        },
        select: {
          deletionRequestedAt: true,
          deletionStatus: true,
        },
      }),
    ]);

    const trendMap = new Map<
      string,
      {
        month: string;
        requests: number;
        completed: number;
        cancelled: number;
      }
    >();

    for (let offset = 0; offset < 12; offset += 1) {
      const date = new Date(
        trendStart
      );
      date.setMonth(
        trendStart.getMonth() +
          offset
      );
      const key = `${date.getFullYear()}-${String(
        date.getMonth() + 1
      ).padStart(2, "0")}`;
      trendMap.set(key, {
        month: key,
        requests: 0,
        completed: 0,
        cancelled: 0,
      });
    }

    for (const row of trendRows) {
      if (!row.deletionRequestedAt) {
        continue;
      }

      const key = `${row.deletionRequestedAt.getFullYear()}-${String(
        row.deletionRequestedAt.getMonth() +
          1
      ).padStart(2, "0")}`;
      const entry =
        trendMap.get(key);
      if (!entry) {
        continue;
      }

      entry.requests += 1;
      if (
        row.deletionStatus ===
        AccountDeletionStatus.COMPLETED
      ) {
        entry.completed += 1;
      }
      if (
        row.deletionStatus ===
        AccountDeletionStatus.CANCELLED
      ) {
        entry.cancelled += 1;
      }
    }

    return {
      totalRequests,
      pendingDeletion,
      cancelledByLogin,
      completedDeletions,
      topReasons: reasonGroups.map(
        (row) => ({
          reason: row.deletionReason,
          count: row._count._all,
        })
      ),
      statusBreakdown:
        statusGroups.map((row) => ({
          status: row.deletionStatus,
          count: row._count._all,
        })),
      monthlyTrend: [
        ...trendMap.values(),
      ],
    };
  };
