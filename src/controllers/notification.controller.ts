import { Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { AuthRequest } from "../types/types";
import {
  trackNotificationClick,
  trackNotificationOpen,
} from "../services/notification-campaign.service";

const assertAuthenticatedUser = (req: AuthRequest) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401);
  }
  return req.user;
};

const toInt = (value: unknown, fallback: number) => {
  const parsed =
    typeof value === "number"
      ? value
      : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
};

//////////////////////////////////////////////////////
// GET MY NOTIFICATIONS
//////////////////////////////////////////////////////

export const getMyNotifications = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const unreadOnly =
      String(req.query.unreadOnly ?? "") ===
      "true";

    const page = toInt(req.query.page, 1);
    const pageSize = Math.min(
      50,
      toInt(req.query.pageSize, 20)
    );

    const where = {
      userId: user.id,
      ...(unreadOnly ? { isRead: false } : {}),
    };

    const [total, unreadCount, notifications] =
      await Promise.all([
        prisma.notification.count({
          where,
        }),
        prisma.notification.count({
          where: {
            userId: user.id,
            isRead: false,
          },
        }),
        prisma.notification.findMany({
          where,
          orderBy: {
            createdAt: "desc",
          },
          skip: (page - 1) * pageSize,
          take: pageSize,
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
          },
        }),
      ]);

    const totalPages = Math.max(
      1,
      Math.ceil(total / pageSize)
    );

    res.json(
      successResponse(
        notifications,
        "Notifications fetched",
        {
          page,
          pageSize,
          total,
          totalPages,
          unreadCount,
        }
      )
    );
  }
);

//////////////////////////////////////////////////////
// UNREAD COUNT
//////////////////////////////////////////////////////

export const getUnreadCount = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const count = await prisma.notification.count({
      where: {
        userId: user.id,
        isRead: false,
      },
    });

    res.json(
      successResponse(
        { count },
        "Unread count fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// MARK ONE READ
//////////////////////////////////////////////////////

export const markNotificationRead = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "id");
    const updated = await trackNotificationOpen({
      notificationId: id,
      userId: user.id,
    });

    res.json(
      successResponse(
        updated,
        "Marked as read"
      )
    );
  }
);

//////////////////////////////////////////////////////
// MARK ALL READ
//////////////////////////////////////////////////////

export const markAllRead = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    await prisma.notification.updateMany({
      where: {
        userId: user.id,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    res.json(
      successResponse(null, "All read")
    );
  }
);

//////////////////////////////////////////////////////
// TRACK OPEN
//////////////////////////////////////////////////////

export const openNotification = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "id");

    const updated = await trackNotificationOpen({
      notificationId: id,
      userId: user.id,
    });

    res.json(
      successResponse(
        updated,
        "Notification opened"
      )
    );
  }
);

//////////////////////////////////////////////////////
// TRACK CLICK
//////////////////////////////////////////////////////

export const clickNotification = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "id");

    const updated = await trackNotificationClick({
      notificationId: id,
      userId: user.id,
    });

    res.json(
      successResponse(
        updated,
        "Notification click tracked"
      )
    );
  }
);
