import { Response } from "express";
import {
  NotificationAudienceSegment,
  NotificationAudienceType,
  NotificationCampaignStatus,
  NotificationType,
  Prisma,
} from "../generated/prisma";
import { config } from "../config/config";
import { prisma } from "../lib/prisma";
import { AuthRequest } from "../types/types";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import {
  cancelNotificationCampaign,
  createNotificationCampaign,
  dispatchNotificationCampaign,
  getNotificationCampaignById,
  listNotificationCampaigns,
  updateNotificationCampaign,
} from "../services/notification-campaign.service";
import { getPushProviderDiagnostics } from "../services/push.service";

const notificationDestinationTypes = [
  "NONE",
  "HOME",
  "SERVICES",
  "SERVICE_DETAIL",
  "ORDERS",
  "SEARCH",
  "NOTIFICATIONS",
  "CUSTOM_LINK",
] as const;

const parseEnumValue = <T extends string>(
  value: unknown,
  enumValues: readonly T[],
  fieldName: string,
  { required = true }: { required?: boolean } = {},
) => {
  if (value == null || value === "") {
    if (!required) {
      return undefined;
    }

    throw new AppError(`${fieldName} is required.`, 400);
  }

  if (typeof value !== "string") {
    throw new AppError(`Invalid ${fieldName}.`, 400);
  }

  const normalized = value.trim().toUpperCase() as T;
  if (!enumValues.includes(normalized)) {
    throw new AppError(`Invalid ${fieldName}.`, 400);
  }

  return normalized;
};

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

const parseOptionalDate = (
  value: unknown,
  fieldName: string,
) => {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(`Invalid ${fieldName}.`, 400);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`Invalid ${fieldName}.`, 400);
  }

  return date;
};

const parseTargetUserIds = (value: unknown) => {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError("targetUserIds must be an array.", 400);
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry);
};

const parseJsonData = (value: unknown): Prisma.InputJsonValue | null => {
  if (value == null || value == "") {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Prisma.InputJsonValue;
    } catch {
      throw new AppError("data must be valid JSON.", 400);
    }
  }

  if (typeof value === "object") {
    return value as Prisma.InputJsonValue;
  }

  throw new AppError("data must be valid JSON.", 400);
};

const parseCampaignInput = (body: Record<string, unknown>) => {
  const title = parseOptionalString(body.title);
  if (!title) {
    throw new AppError("title is required.", 400);
  }

  const message = parseOptionalString(body.message);
  if (!message) {
    throw new AppError("message is required.", 400);
  }

  const type = parseEnumValue(
    body.type,
    Object.values(NotificationType),
    "type",
  ) as NotificationType;
  const audienceType = parseEnumValue(
    body.audienceType,
    Object.values(NotificationAudienceType),
    "audienceType",
  ) as NotificationAudienceType;

  const audienceSegment = parseEnumValue(
    body.audienceSegment,
    Object.values(NotificationAudienceSegment),
    "audienceSegment",
    { required: false },
  ) as NotificationAudienceSegment | undefined;

  return {
    title,
    message,
    type,
    audienceType,
    audienceSegment: audienceSegment ?? null,
    targetUserIds: parseTargetUserIds(body.targetUserIds),
    deepLinkPath: normalizeDeepLinkPath(body.deepLinkPath),
    imageUrl: parseOptionalString(body.imageUrl),
    data: parseJsonData(body.data),
    scheduledAt: parseOptionalDate(body.scheduledAt, "scheduledAt"),
  };
};

const assertAdminUser = (req: AuthRequest) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401);
  }

  return req.user;
};

export const getNotificationCampaignMeta = catchAsync(
  async (_req: AuthRequest, res: Response) => {
    const pushDiagnostics = getPushProviderDiagnostics();
    const customerAudienceWhere = {
      role: "USER" as const,
      isActive: true,
      isBlocked: false,
      deletedAt: null,
      deletionStatus: {
        not: "REQUESTED" as const,
      },
    };

    const [allTokens, usersWithTokens, registeredUsersWithTokens] = await Promise.all([
      prisma.deviceToken.findMany({
        select: {
          platform: true,
          user: {
            select: {
              role: true,
              isActive: true,
              isBlocked: true,
              deletedAt: true,
              deletionStatus: true,
            },
          },
        },
      }),
      prisma.user.count({
        where: {
          ...customerAudienceWhere,
          deviceTokens: {
            some: {},
          },
        },
      }),
      prisma.user.count({
        where: {
          deviceTokens: {
            some: {},
          },
        },
      }),
    ]);

    const registeredPlatformCounts = allTokens.reduce(
      (acc, item) => {
        const platform = item.platform.trim().toLowerCase();
        const count = 1;

        if (platform === "android") {
          acc.android += count;
        } else if (platform === "ios") {
          acc.ios += count;
        } else if (platform === "web") {
          acc.web += count;
        } else {
          acc.unknown += count;
        }

        acc.total += count;
        return acc;
      },
      {
        total: 0,
        android: 0,
        ios: 0,
        web: 0,
        unknown: 0,
      },
    );

    const targetableTokens = allTokens.filter(
      (item) =>
        item.user.role === "USER" &&
        item.user.isActive &&
        !item.user.isBlocked &&
        item.user.deletedAt === null &&
        item.user.deletionStatus !== "REQUESTED",
    );

    const platformCounts = targetableTokens.reduce(
      (acc, item) => {
        const platform = item.platform.trim().toLowerCase();
        const count = 1;

        if (platform === "android") {
          acc.android += count;
        } else if (platform === "ios") {
          acc.ios += count;
        } else if (platform === "web") {
          acc.web += count;
        } else {
          acc.unknown += count;
        }

        acc.total += count;
        return acc;
      },
      {
        total: 0,
        android: 0,
        ios: 0,
        web: 0,
        unknown: 0,
      },
    );

    res.json(
      successResponse(
        {
          notificationTypes: Object.values(NotificationType),
          audienceTypes: Object.values(NotificationAudienceType),
          audienceSegments: Object.values(NotificationAudienceSegment),
          statuses: Object.values(NotificationCampaignStatus),
          destinationTypes: [...notificationDestinationTypes],
          health: {
            pushProviderConfigured: pushDiagnostics.ready,
            firebaseCredentialConfigured: pushDiagnostics.configured,
            firebaseProjectId: pushDiagnostics.projectId,
            credentialSource: pushDiagnostics.credentialSource,
            providerInitialized: pushDiagnostics.initialized,
            providerError: pushDiagnostics.errorMessage,
            schedulerEnabled:
              config.ENABLE_NOTIFICATION_CAMPAIGN_SCHEDULER,
            schedulerIntervalMs:
              config.NOTIFICATION_CAMPAIGN_SCHEDULER_INTERVAL_MS,
            usersWithTokens,
            registeredUsersWithTokens,
            totalDeviceTokens: platformCounts.total,
            registeredDeviceTokens:
              registeredPlatformCounts.total,
            excludedDeviceTokens:
              registeredPlatformCounts.total -
              platformCounts.total,
            platformCounts: {
              android: platformCounts.android,
              ios: platformCounts.ios,
              web: platformCounts.web,
              unknown: platformCounts.unknown,
            },
            registeredPlatformCounts: {
              android:
                registeredPlatformCounts.android,
              ios: registeredPlatformCounts.ios,
              web: registeredPlatformCounts.web,
              unknown:
                registeredPlatformCounts.unknown,
            },
          },
        },
        "Notification campaign metadata fetched",
      ),
    );
  },
);

export const getNotificationCampaignList = catchAsync(
  async (req: AuthRequest, res: Response) => {
    assertAdminUser(req);
    const search =
      parseOptionalString(req.query.search) ??
      undefined;

    const status = parseEnumValue(
      req.query.status,
      Object.values(NotificationCampaignStatus),
      "status",
      { required: false },
    ) as NotificationCampaignStatus | undefined;

    const type = parseEnumValue(
      req.query.type,
      Object.values(NotificationType),
      "type",
      { required: false },
    ) as NotificationType | undefined;

    const audienceType = parseEnumValue(
      req.query.audienceType,
      Object.values(NotificationAudienceType),
      "audienceType",
      { required: false },
    ) as NotificationAudienceType | undefined;

    const result = await listNotificationCampaigns({
      ...(search
        ? {
            search,
          }
        : {}),
      ...(status
        ? {
            status,
          }
        : {}),
      ...(type
        ? {
            type,
          }
        : {}),
      ...(audienceType
        ? {
            audienceType,
          }
        : {}),
      page: Number(req.query.page),
      pageSize: Number(req.query.pageSize),
    });

    res.json(
      successResponse(
        result.data,
        "Notification campaigns fetched",
        result.meta,
      ),
    );
  },
);

export const getNotificationCampaign = catchAsync(
  async (req: AuthRequest, res: Response) => {
    assertAdminUser(req);

    const id = getParam(req.params.id, "id");
    const campaign = await getNotificationCampaignById(id);

    res.json(
      successResponse(
        campaign,
        "Notification campaign fetched",
      ),
    );
  },
);

export const createNotificationCampaignRecord = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAdminUser(req);
    const input = parseCampaignInput(req.body as Record<string, unknown>);
    const sendNow = req.body.sendNow === true;

    const campaign = await createNotificationCampaign({
      input,
      createdById: user.id,
      sendNow,
    });

    res.status(201).json(
      successResponse(
        campaign,
        sendNow
          ? "Notification campaign sent"
          : "Notification campaign created",
      ),
    );
  },
);

export const updateNotificationCampaignRecord = catchAsync(
  async (req: AuthRequest, res: Response) => {
    assertAdminUser(req);

    const id = getParam(req.params.id, "id");
    const input = parseCampaignInput(req.body as Record<string, unknown>);

    const campaign = await updateNotificationCampaign({
      id,
      input,
    });

    res.json(
      successResponse(
        campaign,
        "Notification campaign updated",
      ),
    );
  },
);

export const sendNotificationCampaignNow = catchAsync(
  async (req: AuthRequest, res: Response) => {
    assertAdminUser(req);

    const id = getParam(req.params.id, "id");
    const campaign = await dispatchNotificationCampaign(id);

    res.json(
      successResponse(
        campaign,
        "Notification campaign dispatched",
      ),
    );
  },
);

export const cancelNotificationCampaignRecord = catchAsync(
  async (req: AuthRequest, res: Response) => {
    assertAdminUser(req);

    const id = getParam(req.params.id, "id");
    const campaign = await cancelNotificationCampaign(id);

    res.json(
      successResponse(
        campaign,
        "Notification campaign cancelled",
      ),
    );
  },
);
