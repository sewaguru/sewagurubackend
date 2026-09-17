import { Router } from "express";

import {
  sendOtp,
  verifyOtp,
  sendAdminOtp,
  verifyAdminOtp,
  logout,
  getMe,
} from "../controllers/auth.controller";

import { requireAuth } from "../middlewares/auth.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import { config } from "../config/config";
import googleAuthRoutes from "../auth/auth.routes";

const router = Router();

if (config.AUTH_GOOGLE_ENABLED) {
  router.use("/", googleAuthRoutes);
}

//////////////////////////////////////////////////////
// USER AUTH
//////////////////////////////////////////////////////

/**
 * Request OTP
 * Strict limiter → prevents SMS/email abuse
 */
router.post(
  "/send-otp",
  rateLimiters.otpSend,
  sendOtp
);

/**
 * Verify OTP
 * Relaxed limiter → allows user mistakes
 */
router.post(
  "/verify-otp",
  rateLimiters.otpVerify,
  verifyOtp
);

//////////////////////////////////////////////////////
// ADMIN AUTH
//////////////////////////////////////////////////////

/**
 * Admin OTP Request
 * Very strict protection
 */
router.post(
  "/admin/send-otp",
  rateLimiters.adminAuth,
  sendAdminOtp
);

/**
 * Admin OTP Verify
 */
router.post(
  "/admin/verify-otp",
  rateLimiters.adminAuth,
  verifyAdminOtp
);

//////////////////////////////////////////////////////
// SESSION
//////////////////////////////////////////////////////

/**
 * Current Logged User
 */
router.get(
  "/me",
  rateLimiters.authenticated,
  requireAuth,
  getMe
);

/**
 * Logout
 */
router.post(
  "/logout",
  rateLimiters.authenticated,
  logout
);

export default router;