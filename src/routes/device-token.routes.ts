import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import * as deviceTokenController from "../controllers/device-token.controller";

const router = Router();

// POST /api/device-tokens   { token, platform, deviceId?, appVersion? }
router.post(
  "/",
  rateLimiters.authenticated,
  requireAuth,
  deviceTokenController.registerDeviceToken
);

// POST /api/device-tokens/register   { token, platform, deviceId?, appVersion? }
router.post(
  "/register",
  rateLimiters.authenticated,
  requireAuth,
  deviceTokenController.registerDeviceToken
);

// POST /api/device-tokens/unregister { token }
router.post(
  "/unregister",
  rateLimiters.authenticated,
  requireAuth,
  deviceTokenController.unregisterDeviceToken
);

export default router;
