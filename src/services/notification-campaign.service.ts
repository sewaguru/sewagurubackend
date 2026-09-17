import {
  NotificationAudienceSegment,
  NotificationAudienceType,
  NotificationCampaignStatus,
  NotificationDeliveryChannel,
  NotificationDeliveryStatus,
  NotificationDeliveryState,
  NotificationEvent,
  NotificationType,
  Prisma,
} from "../generated/prisma";
import { config } from "../config/config";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import {
  sendPushToUserDetailed,
  type PushUserDispatchResult,
} from "./push.service";

type CampaignWithCreator = Prisma.NotificationCampaignGetPayload<{
  include: {
    createdBy: {
      include: {
        profile: true;
      };
    };
  };
}>;

type CampaignInput = {
  title: string;
  message: string;
  type: NotificationType;
  audienceType: NotificationAudienceType;
  audienceSegment?: NotificationAudienceSegment | null;
  targetUserIds?: string[];
  deepLinkPath?: string | null;
  imageUrl?: string | null;
  data?: Prisma.InputJsonValue | null;
  scheduledAt?: Date | null;
};

type CampaignFilters = {
  search?: string;
  status?: NotificationCampaignStatus;
  type?: NotificationType;
  audienceType?: NotificationAudienceType;
  page?: number;
  pageSize?: number;
};

const SCHEDULER_INTERVAL_MS =
  config.NOTIFICATION_CAMPAIGN_SCHEDULER_INTERVAL_MS;
const DISPATCH_CONCURRENCY = 25;

const editableStatuses = new Set<NotificationCampaignStatus>([
  NotificationCampaignStatus.DRAFT,
  NotificationCampaignStatus.SCHEDULED,
  NotificationCampaignStatus.FAILED,
  NotificationCampaignStatus.CANCELLED,
]);

const cancellableStatuses = new Set<NotificationCampaignStatus>([
  NotificationCampaignStatus.DRAFT,
  NotificationCampaignStatus.SCHEDULED,
]);

const resolveAudienceWindowCutoff = (days: number) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
};

const normalizeUserIds = (userIds?: string[]) =>
  [...new Set((userIds ?? []).map((id) => id.trim()).filter((id) => id))];

const isScheduledAtDue = (
  scheduledAt?: Date | null,
) =>
  Boolean(
    scheduledAt &&
      scheduledAt.getTime() <= Date.now(),
  );

const resolveDraftOrScheduledStatus = ({
  scheduledAt,
  sendNow = false,
}: {
  scheduledAt: Date | null | undefined;
  sendNow?: boolean;
}) => {
  if (sendNow) {
    return NotificationCampaignStatus.DRAFT;
  }

  return scheduledAt
    ? NotificationCampaignStatus.SCHEDULED
    : NotificationCampaignStatus.DRAFT;
};

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.floor(parsed));
};

const buildAudienceWhere = ({
  audienceType,
  audienceSegment,
  targetUserIds,
}: {
  audienceType: NotificationAudienceType;
  audienceSegment: NotificationAudienceSegment | null | undefined;
  targetUserIds: string[] | undefined;
}): Prisma.UserWhereInput => {
  const baseWhere: Prisma.UserWhereInput = {
    role: "USER",
    isActive: true,
    isBlocked: false,
    deletedAt: null,
    deletionStatus: {
      not: "REQUESTED",
    },
  };

  if (audienceType === NotificationAudienceType.ALL_USERS) {
    return baseWhere;
  }

  if (audienceType === NotificationAudienceType.INDIVIDUAL_USERS) {
    const normalizedIds = normalizeUserIds(targetUserIds);
    if (!normalizedIds.length) {
      throw new AppError(
        "Select at least one user for individual targeting.",
        400,
      );
    }

    return {
      ...baseWhere,
      id: { in: normalizedIds },
    };
  }

  if (!audienceSegment) {
    throw new AppError("Select a valid audience segment.", 400);
  }

  const last30Days = resolveAudienceWindowCutoff(30);

  switch (audienceSegment) {
    case NotificationAudienceSegment.ACTIVE_LAST_30_DAYS:
      return {
        ...baseWhere,
        OR: [
          {
            lastActiveAt: {
              gte: last30Days,
            },
          },
          {
            bookings: {
              some: {
                createdAt: {
                  gte: last30Days,
                },
              },
            },
          },
        ],
      };
    case NotificationAudienceSegment.INACTIVE_LAST_30_DAYS:
      return {
        ...baseWhere,
        OR: [
          {
            lastActiveAt: null,
            createdAt: {
              lt: last30Days,
            },
          },
          {
            lastActiveAt: {
              lt: last30Days,
            },
          },
        ],
      };
    case NotificationAudienceSegment.USERS_WITHOUT_BOOKINGS:
      return {
        ...baseWhere,
        totalBookings: 0,
      };
    case NotificationAudienceSegment.USERS_WITH_BOOKINGS:
      return {
        ...baseWhere,
        totalBookings: {
          gt: 0,
        },
      };
    case NotificationAudienceSegment.RECENT_SIGNUPS:
      return {
        ...baseWhere,
        createdAt: {
          gte: last30Days,
        },
      };
  }
};

const resolveAudienceUserIds = async ({
  audienceType,
  audienceSegment,
  targetUserIds,
}: {
  audienceType: NotificationAudienceType;
  audienceSegment: NotificationAudienceSegment | null | undefined;
  targetUserIds: string[] | undefined;
}) => {
  const users = await prisma.user.findMany({
    where: buildAudienceWhere({
      audienceType,
      audienceSegment,
      targetUserIds,
    }),
    select: {
      id: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return users.map((user) => user.id);
};

const computeCampaignStatus = ({
  scheduledAt,
  sentAt,
  currentStatus,
  deliveredCount,
  failedCount,
  skippedCount,
}: {
  scheduledAt?: Date | null;
  sentAt?: Date | null;
  currentStatus?: NotificationCampaignStatus;
  deliveredCount?: number;
  failedCount?: number;
  skippedCount?: number;
}) => {
  const delivered = deliveredCount ?? 0;
  const failed = failedCount ?? 0;
  const skipped = skippedCount ?? 0;

  if (
    currentStatus === NotificationCampaignStatus.PROCESSING &&
    !sentAt &&
    delivered === 0 &&
    failed === 0 &&
    skipped === 0
  ) {
    return NotificationCampaignStatus.PROCESSING;
  }

  if (
    currentStatus === NotificationCampaignStatus.SCHEDULED &&
    !sentAt &&
    scheduledAt
  ) {
    return NotificationCampaignStatus.SCHEDULED;
  }

  if (
    scheduledAt &&
    scheduledAt.getTime() > Date.now() &&
    !sentAt
  ) {
    return NotificationCampaignStatus.SCHEDULED;
  }

  if (delivered > 0 && (failed > 0 || skipped > 0)) {
    return NotificationCampaignStatus.PARTIAL;
  }

  if (delivered > 0) {
    return NotificationCampaignStatus.SENT;
  }

  if (failed > 0 || skipped > 0) {
    return NotificationCampaignStatus.FAILED;
  }

  return NotificationCampaignStatus.DRAFT;
};

const queueDueNotificationCampaignProcessing = ({
  campaignId,
  scheduledAt,
}: {
  campaignId: string;
  scheduledAt: Date | null | undefined;
}) => {
  if (!isScheduledAtDue(scheduledAt)) {
    return;
  }

  if (
    !config.ENABLE_NOTIFICATION_CAMPAIGN_SCHEDULER
  ) {
    console.warn(
      "[NOTIFY] Campaign became due, but the scheduler is disabled.",
      {
        campaignId,
        scheduledAt:
          scheduledAt?.toISOString() ?? null,
      },
    );
    return;
  }

  setTimeout(() => {
    void processDueNotificationCampaigns().catch(
      (error) => {
        console.error(
          "[NOTIFY] Failed to process due campaigns after campaign save.",
          {
            campaignId,
            error,
          },
        );
      },
    );
  }, 0);
};

const serializeCampaign = (
  campaign: CampaignWithCreator,
  meta?: Record<string, unknown>,
) => ({
  id: campaign.id,
  title: campaign.title,
  message: campaign.message,
  type: campaign.type,
  audienceType: campaign.audienceType,
  audienceSegment: campaign.audienceSegment,
  targetUserIds: campaign.targetUserIds,
  status: campaign.status,
  deepLinkPath: campaign.deepLinkPath,
  imageUrl: campaign.imageUrl,
  data: campaign.data,
  scheduledAt: campaign.scheduledAt,
  processingStartedAt: campaign.processingStartedAt,
  sentAt: campaign.sentAt,
  resolvedAudienceCount: campaign.resolvedAudienceCount,
  deliveredCount: campaign.deliveredCount,
  failedCount: campaign.failedCount,
  skippedCount: campaign.skippedCount,
  openedCount: campaign.openedCount,
  clickedCount: campaign.clickedCount,
  lastError: campaign.lastError,
  createdAt: campaign.createdAt,
  updatedAt: campaign.updatedAt,
  analytics: {
    targetedCount: campaign.resolvedAudienceCount,
    deliveredCount: campaign.deliveredCount,
    failedCount: campaign.failedCount,
    skippedCount: campaign.skippedCount,
    openedCount: campaign.openedCount,
    clickedCount: campaign.clickedCount,
    deliveryRate:
      campaign.resolvedAudienceCount > 0
        ? Number(
            (
              (campaign.deliveredCount / campaign.resolvedAudienceCount) *
              100
            ).toFixed(1),
          )
        : 0,
    openRate:
      campaign.resolvedAudienceCount > 0
        ? Number(
            (
              (campaign.openedCount / campaign.resolvedAudienceCount) *
              100
            ).toFixed(1),
          )
        : 0,
    clickRate:
      campaign.resolvedAudienceCount > 0
        ? Number(
            (
              (campaign.clickedCount / campaign.resolvedAudienceCount) *
              100
            ).toFixed(1),
          )
        : 0,
  },
  createdBy: {
    id: campaign.createdBy.id,
    role: campaign.createdBy.role,
    fullName: campaign.createdBy.profile?.fullName ?? null,
    email: campaign.createdBy.profile?.email ?? null,
  },
  ...(meta ? { meta } : {}),
});

const getCampaignOrThrow = async (id: string) => {
  const campaign = await prisma.notificationCampaign.findUnique({
    where: { id },
    include: {
      createdBy: {
        include: {
          profile: true,
        },
      },
    },
  });

  if (!campaign) {
    throw new AppError("Notification campaign not found.", 404);
  }

  return campaign;
};

const dedupeCampaignNotifications = async ({
  campaignId,
  userIds,
}: {
  campaignId: string;
  userIds?: string[];
}) => {
  const existingNotifications =
    await prisma.notification.findMany({
      where: {
        campaignId,
        ...(userIds
          ? {
              userId: {
                in: userIds,
              },
            }
          : {}),
      },
      select: {
        id: true,
        userId: true,
        createdAt: true,
      },
      orderBy: [
        {
          userId: "asc",
        },
        {
          createdAt: "desc",
        },
      ],
    });

  const keepNotificationIdByUserId =
    new Map<string, string>();
  const duplicateIds: string[] = [];

  for (const notification of existingNotifications) {
    if (
      keepNotificationIdByUserId.has(
        notification.userId,
      )
    ) {
      duplicateIds.push(notification.id);
      continue;
    }

    keepNotificationIdByUserId.set(
      notification.userId,
      notification.id,
    );
  }

  if (duplicateIds.length) {
    await prisma.notification.deleteMany({
      where: {
        id: {
          in: duplicateIds,
        },
      },
    });

    console.info(
      "[NOTIFY] Removed duplicate campaign notifications.",
      {
        campaignId,
        removedCount: duplicateIds.length,
      },
    );
  }

  return keepNotificationIdByUserId;
};

const refreshCampaignAnalytics = async (campaignId: string) => {
  await dedupeCampaignNotifications({
    campaignId,
  });

  const [
    campaign,
    targetedCount,
    deliveredCount,
    failedCount,
    skippedCount,
    openedCount,
    clickedCount,
  ] = await Promise.all([
    prisma.notificationCampaign.findUnique({
      where: {
        id: campaignId,
      },
      select: {
        status: true,
        scheduledAt: true,
        sentAt: true,
      },
    }),
    prisma.notification.count({
      where: {
        campaignId,
      },
    }),
    prisma.notification.count({
      where: {
        campaignId,
        deliveryStatus: NotificationDeliveryState.DELIVERED,
      },
    }),
    prisma.notification.count({
      where: {
        campaignId,
        deliveryStatus: NotificationDeliveryState.FAILED,
      },
    }),
    prisma.notification.count({
      where: {
        campaignId,
        deliveryStatus: NotificationDeliveryState.SKIPPED,
      },
    }),
    prisma.notification.count({
      where: {
        campaignId,
        openedAt: {
          not: null,
        },
      },
    }),
    prisma.notification.count({
      where: {
        campaignId,
        clickedAt: {
          not: null,
        },
      },
    }),
  ]);

  if (!campaign) {
    return;
  }

  await prisma.notificationCampaign.update({
    where: { id: campaignId },
    data: {
      resolvedAudienceCount: targetedCount,
      deliveredCount,
      failedCount,
      skippedCount,
      openedCount,
      clickedCount,
      status: computeCampaignStatus({
        currentStatus: campaign.status,
        scheduledAt: campaign.scheduledAt,
        sentAt: campaign.sentAt,
        deliveredCount,
        failedCount,
        skippedCount,
      }),
    },
  });
};

const createCampaignNotifications = async ({
  campaign,
  userIds,
}: {
  campaign: CampaignWithCreator;
  userIds: string[];
}) => {
  const existingNotificationIdByUserId =
    await dedupeCampaignNotifications({
      campaignId: campaign.id,
      userIds,
    });

  const reusableNotificationIds = [
    ...existingNotificationIdByUserId.values(),
  ];

  if (reusableNotificationIds.length) {
    await prisma.notification.updateMany({
      where: {
        id: {
          in: reusableNotificationIds,
        },
      },
      data: {
        type: campaign.type,
        title: campaign.title,
        message: campaign.message,
        linkUrl: campaign.deepLinkPath,
        imageUrl: campaign.imageUrl,
        data: campaign.data ?? Prisma.JsonNull,
        deliveryStatus:
          NotificationDeliveryState.PENDING,
        deliveredAt: null,
        isRead: false,
        readAt: null,
        openedAt: null,
        clickedAt: null,
      },
    });
  }

  const missingUserIds = userIds.filter(
    (userId) =>
      !existingNotificationIdByUserId.has(
        userId,
      ),
  );

  const createdNotificationIdByUserId =
    new Map<string, string>();

  const batchSize = 200;
  for (
    let start = 0;
    start < missingUserIds.length;
    start += batchSize
  ) {
    const batch = missingUserIds.slice(
      start,
      start + batchSize,
    );
    const createdBatch =
      await prisma.notification.createManyAndReturn({
        data: batch.map((userId) => ({
          userId,
          campaignId: campaign.id,
          type: campaign.type,
          title: campaign.title,
          message: campaign.message,
          linkUrl: campaign.deepLinkPath,
          imageUrl: campaign.imageUrl,
          data: campaign.data ?? Prisma.JsonNull,
          deliveryStatus:
            NotificationDeliveryState.PENDING,
        })),
        select: {
          id: true,
          userId: true,
        },
      });

    for (const notification of createdBatch) {
      createdNotificationIdByUserId.set(
        notification.userId,
        notification.id,
      );
    }
  }

  return userIds.map((userId) => {
    const notificationId =
      existingNotificationIdByUserId.get(
        userId,
      ) ??
      createdNotificationIdByUserId.get(userId);

    if (!notificationId) {
      throw new AppError(
        `Notification row missing for campaign user ${userId}.`,
        500,
      );
    }

    return {
      id: notificationId,
      userId,
    };
  });
};

const buildPushPayload = ({
  campaign,
  notificationId,
}: {
  campaign: CampaignWithCreator;
  notificationId: string;
}) => ({
  title: campaign.title,
  body: campaign.message,
  data: {
    type: campaign.type,
    notificationId,
    campaignId: campaign.id,
    linkUrl: campaign.deepLinkPath ?? "",
  },
  ...(campaign.imageUrl
    ? {
        imageUrl: campaign.imageUrl,
      }
    : {}),
});

const resolveDispatchFailureMessage = (
  notificationResults: Array<
    PushUserDispatchResult & {
      notificationId: string;
    }
  >,
) => {
  const deliveredCount = notificationResults.filter(
    (result) => result.status === "DELIVERED",
  ).length;
  const failedCount = notificationResults.filter(
    (result) => result.status === "FAILED",
  ).length;
  const skippedCount = notificationResults.filter(
    (result) => result.status === "SKIPPED",
  ).length;

  if (deliveredCount > 0) {
    return null;
  }

  const distinctErrors = [
    ...new Set(
      notificationResults
        .map((result) => result.errorMessage?.trim())
        .filter(
          (message): message is string => Boolean(message),
        ),
    ),
  ];

  if (distinctErrors.length === 1) {
    if (
      distinctErrors[0] ===
      "No active device tokens were found for this user."
    ) {
      return "No targeted users had active device tokens.";
    }

    return distinctErrors[0];
  }

  if (skippedCount > 0 && failedCount === 0) {
    return "No push notifications could be delivered to the selected audience.";
  }

  if (failedCount > 0 && skippedCount === 0) {
    return "Notification dispatch failed for all targeted users.";
  }

  if (failedCount > 0 || skippedCount > 0) {
    return "Notification dispatch did not reach any targeted users.";
  }

  return "Notification dispatch failed.";
};

const mapWithConcurrency = async <TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
) => {
  const results = new Array<TOutput>(items.length);
  let cursor = 0;

  const workers = Array.from({
    length: Math.min(concurrency, items.length),
  }).map(async () => {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      const item = items[index];
      if (typeof item === "undefined") {
        return;
      }

      results[index] = await mapper(item, index);
    }
  });

  await Promise.all(workers);
  return results;
};

const applyDeliveryResults = async ({
  campaignId,
  notificationResults,
}: {
  campaignId: string;
  notificationResults: Array<
    PushUserDispatchResult & {
      notificationId: string;
    }
  >;
}) => {
  const deliveredIds = notificationResults
    .filter((result) => result.status === "DELIVERED")
    .map((result) => result.notificationId);
  const failedIds = notificationResults
    .filter((result) => result.status === "FAILED")
    .map((result) => result.notificationId);
  const skippedIds = notificationResults
    .filter((result) => result.status === "SKIPPED")
    .map((result) => result.notificationId);

  const now = new Date();

  if (deliveredIds.length) {
    await prisma.notification.updateMany({
      where: {
        id: {
          in: deliveredIds,
        },
      },
      data: {
        deliveryStatus: NotificationDeliveryState.DELIVERED,
        deliveredAt: now,
      },
    });
  }

  if (failedIds.length) {
    await prisma.notification.updateMany({
      where: {
        id: {
          in: failedIds,
        },
      },
      data: {
        deliveryStatus: NotificationDeliveryState.FAILED,
      },
    });
  }

  if (skippedIds.length) {
    await prisma.notification.updateMany({
      where: {
        id: {
          in: skippedIds,
        },
      },
      data: {
        deliveryStatus: NotificationDeliveryState.SKIPPED,
      },
    });
  }

  const deliveredCount = deliveredIds.length;
  const failedCount = failedIds.length;
  const skippedCount = skippedIds.length;
  const dispatchFailureMessage =
    resolveDispatchFailureMessage(
      notificationResults,
    );

  if (notificationResults.length) {
    await prisma.notificationDeliveryLog.createMany({
      data: notificationResults.map((result) => ({
        channel: NotificationDeliveryChannel.PUSH,
        event: NotificationEvent.NOTIFICATION_CAMPAIGN,
        status:
          result.status === "DELIVERED"
            ? NotificationDeliveryStatus.SENT
            : result.status === "FAILED"
              ? NotificationDeliveryStatus.FAILED
              : NotificationDeliveryStatus.SKIPPED,
        provider: "FCM",
        recipient: `push:${result.userId}`,
        userId: result.userId,
        payload: {
          campaignId,
          notificationId: result.notificationId,
          tokenCount: result.tokenCount,
          deliveredDeviceCount: result.deliveredDeviceCount,
          failedDeviceCount: result.failedDeviceCount,
          errorMessage: result.errorMessage ?? null,
        },
        errorMessage: result.errorMessage ?? null,
      })),
    });
  }

  await prisma.notificationCampaign.update({
    where: { id: campaignId },
    data: {
      sentAt: now,
      lastError:
        dispatchFailureMessage ?? null,
      deliveredCount,
      failedCount,
      skippedCount,
      status: computeCampaignStatus({
        sentAt: now,
        deliveredCount,
        failedCount,
        skippedCount,
      }),
    },
  });
};

export const createNotificationCampaign = async ({
  input,
  createdById,
  sendNow = false,
}: {
  input: CampaignInput;
  createdById: string;
  sendNow?: boolean;
}) => {
  const resolvedAudienceCount = await prisma.user.count({
    where: buildAudienceWhere({
      audienceType: input.audienceType,
      audienceSegment: input.audienceSegment,
      targetUserIds: input.targetUserIds,
    }),
  });

  const scheduledStatus =
    resolveDraftOrScheduledStatus({
      scheduledAt: input.scheduledAt,
      sendNow,
    });

  const campaign = await prisma.notificationCampaign.create({
    data: {
      title: input.title,
      message: input.message,
      type: input.type,
      audienceType: input.audienceType,
      audienceSegment: input.audienceSegment ?? null,
      targetUserIds: normalizeUserIds(input.targetUserIds),
      status: scheduledStatus,
      deepLinkPath: input.deepLinkPath ?? null,
      imageUrl: input.imageUrl ?? null,
      data: input.data ?? Prisma.JsonNull,
      scheduledAt: input.scheduledAt ?? null,
      resolvedAudienceCount,
      createdById,
    },
    include: {
      createdBy: {
        include: {
          profile: true,
        },
      },
    },
  });

  if (sendNow) {
    return dispatchNotificationCampaign(campaign.id);
  }

  queueDueNotificationCampaignProcessing({
    campaignId: campaign.id,
    scheduledAt: campaign.scheduledAt,
  });

  return serializeCampaign(campaign);
};

export const updateNotificationCampaign = async ({
  id,
  input,
}: {
  id: string;
  input: CampaignInput;
}) => {
  const existing = await getCampaignOrThrow(id);

  if (!editableStatuses.has(existing.status)) {
    throw new AppError(
      "Only draft or scheduled campaigns can be edited.",
      409,
    );
  }

  const resolvedAudienceCount = await prisma.user.count({
    where: buildAudienceWhere({
      audienceType: input.audienceType,
      audienceSegment: input.audienceSegment,
      targetUserIds: input.targetUserIds,
    }),
  });

  const nextStatus =
    resolveDraftOrScheduledStatus({
      scheduledAt: input.scheduledAt,
    });

  const updated = await prisma.notificationCampaign.update({
    where: { id },
    data: {
      title: input.title,
      message: input.message,
      type: input.type,
      audienceType: input.audienceType,
      audienceSegment: input.audienceSegment ?? null,
      targetUserIds: normalizeUserIds(input.targetUserIds),
      deepLinkPath: input.deepLinkPath ?? null,
      imageUrl: input.imageUrl ?? null,
      data: input.data ?? Prisma.JsonNull,
      scheduledAt: input.scheduledAt ?? null,
      resolvedAudienceCount,
      lastError: null,
      status: nextStatus,
    },
    include: {
      createdBy: {
        include: {
          profile: true,
        },
      },
    },
  });

  queueDueNotificationCampaignProcessing({
    campaignId: updated.id,
    scheduledAt: updated.scheduledAt,
  });

  return serializeCampaign(updated);
};

export const listNotificationCampaigns = async (filters: CampaignFilters) => {
  const page = toPositiveInt(filters.page, 1);
  const pageSize = Math.min(50, toPositiveInt(filters.pageSize, 12));

  const where: Prisma.NotificationCampaignWhereInput = {
    ...(filters.search?.trim()
      ? {
          OR: [
            {
              title: {
                contains: filters.search.trim(),
                mode: "insensitive",
              },
            },
            {
              message: {
                contains: filters.search.trim(),
                mode: "insensitive",
              },
            },
          ],
        }
      : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.audienceType ? { audienceType: filters.audienceType } : {}),
  };

  const [total, campaigns, statusGroups] = await Promise.all([
    prisma.notificationCampaign.count({ where }),
    prisma.notificationCampaign.findMany({
      where,
      orderBy: [
        {
          createdAt: "desc",
        },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        createdBy: {
          include: {
            profile: true,
          },
        },
      },
    }),
    prisma.notificationCampaign.groupBy({
      by: ["status"],
      where,
      _count: {
        _all: true,
      },
    }),
  ]);

  const summary = {
    total,
    draft: 0,
    scheduled: 0,
    processing: 0,
    sent: 0,
    partial: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const group of statusGroups) {
    const key = group.status.toLowerCase() as keyof typeof summary;
    if (key in summary) {
      summary[key] = group._count._all;
    }
  }

  return {
    data: campaigns.map((campaign) => serializeCampaign(campaign)),
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      summary,
    },
  };
};

export const getNotificationCampaignById = async (id: string) => {
  const campaign = await getCampaignOrThrow(id);
  return serializeCampaign(campaign);
};

export const cancelNotificationCampaign = async (id: string) => {
  const campaign = await getCampaignOrThrow(id);

  if (!cancellableStatuses.has(campaign.status)) {
    throw new AppError("Only draft or scheduled campaigns can be cancelled.", 409);
  }

  const updated = await prisma.notificationCampaign.update({
    where: { id },
    data: {
      status: NotificationCampaignStatus.CANCELLED,
      lastError: null,
    },
    include: {
      createdBy: {
        include: {
          profile: true,
        },
      },
    },
  });

  return serializeCampaign(updated);
};

export const dispatchNotificationCampaign = async (id: string) => {
  const campaign = await getCampaignOrThrow(id);

  console.info("[NOTIFY] Dispatch requested.", {
    campaignId: campaign.id,
    title: campaign.title,
    status: campaign.status,
    audienceType: campaign.audienceType,
  });

  if (campaign.status === NotificationCampaignStatus.PROCESSING) {
    throw new AppError("Notification campaign is already being processed.", 409);
  }

  if (campaign.status === NotificationCampaignStatus.SENT) {
    throw new AppError("Notification campaign has already been sent.", 409);
  }

  if (campaign.status === NotificationCampaignStatus.CANCELLED) {
    throw new AppError("Cancelled campaigns cannot be sent.", 409);
  }

  await prisma.notificationCampaign.update({
    where: { id },
    data: {
      status: NotificationCampaignStatus.PROCESSING,
      processingStartedAt: new Date(),
      lastError: null,
    },
  });

  try {
    const targetUserIds = await resolveAudienceUserIds({
      audienceType: campaign.audienceType,
      audienceSegment: campaign.audienceSegment,
      targetUserIds: campaign.targetUserIds,
    });

    await prisma.notificationCampaign.update({
      where: { id },
      data: {
        resolvedAudienceCount: targetUserIds.length,
      },
    });

    console.info("[NOTIFY] Audience resolved.", {
      campaignId: id,
      targetedUsers: targetUserIds.length,
    });

    if (!targetUserIds.length) {
      await prisma.notificationCampaign.update({
        where: { id },
        data: {
          status: NotificationCampaignStatus.FAILED,
          lastError: "No users matched the selected audience.",
          sentAt: new Date(),
        },
      });
      throw new AppError(
        "No users matched the selected audience.",
        409,
      );
    }

    const createdNotifications = await createCampaignNotifications({
      campaign,
      userIds: targetUserIds,
    });

    const deliveryResults = await mapWithConcurrency(
      createdNotifications,
      DISPATCH_CONCURRENCY,
      async (notification) => {
        const result = await sendPushToUserDetailed(
          notification.userId,
          buildPushPayload({
            campaign,
            notificationId: notification.id,
          }),
        );

        return {
          ...result,
          notificationId: notification.id,
        };
      },
    );

    await applyDeliveryResults({
      campaignId: id,
      notificationResults: deliveryResults,
    });
    await refreshCampaignAnalytics(id);

    const updatedCampaign = await getCampaignOrThrow(id);
    console.info("[NOTIFY] Dispatch completed.", {
      campaignId: id,
      status: updatedCampaign.status,
      deliveredCount: updatedCampaign.deliveredCount,
      failedCount: updatedCampaign.failedCount,
      skippedCount: updatedCampaign.skippedCount,
      lastError: updatedCampaign.lastError,
    });
    if (updatedCampaign.deliveredCount === 0) {
      throw new AppError(
        updatedCampaign.lastError ??
          "Notification dispatch failed.",
        503,
      );
    }

    return serializeCampaign(updatedCampaign);
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.message
        : error instanceof Error
        ? error.message
        : "Notification dispatch failed.";

    console.error("[NOTIFY] Dispatch failed.", {
      campaignId: id,
      message,
    });

    await prisma.notificationCampaign.update({
      where: { id },
      data: {
        status: NotificationCampaignStatus.FAILED,
        lastError: message,
        sentAt: new Date(),
      },
    });

    throw error;
  }
};

let schedulerLocked = false;

export const processDueNotificationCampaigns = async () => {
  if (schedulerLocked) {
    return;
  }

  schedulerLocked = true;

  try {
    const dueCampaigns = await prisma.notificationCampaign.findMany({
      where: {
        status: NotificationCampaignStatus.SCHEDULED,
        scheduledAt: {
          lte: new Date(),
        },
      },
      orderBy: {
        scheduledAt: "asc",
      },
      select: {
        id: true,
      },
    });

    if (dueCampaigns.length > 0) {
      console.info(
        "[NOTIFY] Scheduler found due campaigns.",
        {
          dueCampaignCount:
            dueCampaigns.length,
          campaignIds:
            dueCampaigns.map(
              (campaign) => campaign.id,
            ),
        },
      );
    }

    for (const campaign of dueCampaigns) {
      try {
        await dispatchNotificationCampaign(campaign.id);
      } catch (error) {
        console.error(
          `[NOTIFY] Scheduled campaign ${campaign.id} failed`,
          error,
        );
      }
    }
  } finally {
    schedulerLocked = false;
  }
};

export const startNotificationCampaignScheduler = () => {
  const run = () => {
    void processDueNotificationCampaigns().catch((error) => {
      console.error("[NOTIFY] Failed to process notification campaigns", error);
    });
  };

  run();

  const timer = setInterval(run, SCHEDULER_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
};

export const trackNotificationOpen = async ({
  notificationId,
  userId,
}: {
  notificationId: string;
  userId: string;
}) => {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: {
      id: true,
      userId: true,
      isRead: true,
      openedAt: true,
      campaignId: true,
    },
  });

  if (!notification) {
    throw new AppError("Notification not found", 404);
  }

  if (notification.userId !== userId) {
    throw new AppError("Forbidden", 403);
  }

  const now = new Date();
  const updateData = {
    isRead: true,
    openedAt: notification.openedAt ?? now,
    ...(notification.isRead
      ? {}
      : {
          readAt: now,
        }),
  };
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: updateData,
    select: {
      id: true,
      type: true,
      title: true,
      message: true,
      linkUrl: true,
      imageUrl: true,
      data: true,
      deliveryStatus: true,
      deliveredAt: true,
      isRead: true,
      readAt: true,
      openedAt: true,
      clickedAt: true,
      createdAt: true,
      campaignId: true,
    },
  });

  if (updated.campaignId) {
    await refreshCampaignAnalytics(updated.campaignId);
  }

  return updated;
};

export const trackNotificationClick = async ({
  notificationId,
  userId,
}: {
  notificationId: string;
  userId: string;
}) => {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: {
      id: true,
      userId: true,
      isRead: true,
      openedAt: true,
      clickedAt: true,
      campaignId: true,
    },
  });

  if (!notification) {
    throw new AppError("Notification not found", 404);
  }

  if (notification.userId !== userId) {
    throw new AppError("Forbidden", 403);
  }

  const now = new Date();
  const updateData = {
    isRead: true,
    openedAt: notification.openedAt ?? now,
    clickedAt: notification.clickedAt ?? now,
    ...(notification.isRead
      ? {}
      : {
          readAt: now,
        }),
  };
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: updateData,
    select: {
      id: true,
      type: true,
      title: true,
      message: true,
      linkUrl: true,
      imageUrl: true,
      data: true,
      deliveryStatus: true,
      deliveredAt: true,
      isRead: true,
      readAt: true,
      openedAt: true,
      clickedAt: true,
      createdAt: true,
      campaignId: true,
    },
  });

  if (updated.campaignId) {
    await refreshCampaignAnalytics(updated.campaignId);
  }

  return updated;
};
