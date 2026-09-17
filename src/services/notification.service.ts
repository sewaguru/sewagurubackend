import { prisma } from "../lib/prisma";
import { NotificationType } from "../generated/prisma";
import {
  sendPushToUser,
  sendPushToUsers,
} from "./push.service";

export type NotificationCreatePayload = {
  userId: string;
  type: NotificationType;
  title: string;
  message?: string | null;
  linkUrl?: string | null;
  data?: unknown;
};

export const createNotification = async (
  payload: NotificationCreatePayload
) => {
  const notification =
    await prisma.notification.create({
      data: {
        userId: payload.userId,
        type: payload.type,
        title: payload.title,
        message: payload.message ?? null,
        linkUrl: payload.linkUrl ?? null,
        data: payload.data as any,
      },
    });

  // Fire push best-effort (never throws)
  sendPushToUser(payload.userId, {
    title: payload.title,
    body: payload.message ?? payload.title,
    data: {
      type: payload.type,
      notificationId: notification.id,
      linkUrl: payload.linkUrl ?? "",
    },
  }).catch(() => {});

  return notification;
};

export const createNotificationsForUsers = async (
  userIds: string[],
  payload: Omit<NotificationCreatePayload, "userId">
) => {
  const uniqueUserIds = [
    ...new Set(
      userIds.filter(
        (id) =>
          typeof id === "string" && id.length > 0
      )
    ),
  ];

  if (!uniqueUserIds.length) {
    return { count: 0 };
  }

  const result = await prisma.notification.createMany({
    data: uniqueUserIds.map((userId) => ({
      userId,
      type: payload.type,
      title: payload.title,
      message: payload.message ?? null,
      linkUrl: payload.linkUrl ?? null,
      data: payload.data as any,
    })),
  });

  // Fire push best-effort
  sendPushToUsers(uniqueUserIds, {
    title: payload.title,
    body: payload.message ?? payload.title,
    data: {
      type: payload.type,
      linkUrl: payload.linkUrl ?? "",
    },
  }).catch(() => {});

  return result;
};

export const notifyBranchAdmins = async (
  branchId: string,
  payload: Omit<NotificationCreatePayload, "userId">
) => {
  const admins = await prisma.branchAdmin.findMany({
    where: { branchId },
    select: { userId: true },
  });

  return createNotificationsForUsers(
    admins.map((a) => a.userId),
    payload
  );
};
