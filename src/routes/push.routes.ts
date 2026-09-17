import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import * as pushController from "../controllers/push.controller";

const router = Router();

router.post(
  "/send-test",
  rateLimiters.authenticated,
  requireAuth,
  requireSuperAdmin,
  pushController.sendTestPushNotification,
);

export default router;
