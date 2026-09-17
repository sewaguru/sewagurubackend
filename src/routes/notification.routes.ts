import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import * as notificationController from "../controllers/notification.controller";
import * as notificationAdminController from "../controllers/notification-admin.controller";

const router = Router();

router.get(
  "/admin/meta",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  notificationAdminController.getNotificationCampaignMeta
);

router.get(
  "/admin/campaigns",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  notificationAdminController.getNotificationCampaignList
);

router.post(
  "/admin/campaigns",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  notificationAdminController.createNotificationCampaignRecord
);

router.get(
  "/admin/campaigns/:id",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  notificationAdminController.getNotificationCampaign
);

router.patch(
  "/admin/campaigns/:id",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  notificationAdminController.updateNotificationCampaignRecord
);

router.post(
  "/admin/campaigns/:id/send",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  notificationAdminController.sendNotificationCampaignNow
);

router.post(
  "/admin/campaigns/:id/cancel",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  notificationAdminController.cancelNotificationCampaignRecord
);

router.get(
  "/",
  rateLimiters.authenticated,
  requireAuth,
  notificationController.getMyNotifications
);

router.get(
  "/unread-count",
  rateLimiters.authenticated,
  requireAuth,
  notificationController.getUnreadCount
);

router.post(
  "/read-all",
  rateLimiters.authenticated,
  requireAuth,
  notificationController.markAllRead
);

router.post(
  "/:id/open",
  rateLimiters.authenticated,
  requireAuth,
  notificationController.openNotification
);

router.post(
  "/:id/click",
  rateLimiters.authenticated,
  requireAuth,
  notificationController.clickNotification
);

router.post(
  "/:id/read",
  rateLimiters.authenticated,
  requireAuth,
  notificationController.markNotificationRead
);

export default router;
