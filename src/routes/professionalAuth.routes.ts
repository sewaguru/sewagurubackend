import { Router } from "express";

import {
  sendProfessionalOtp,
  verifyProfessionalOtp,
  getMeProfessional,
} from "../controllers/professionalAuth.controller";

import { requireAuth } from "../middlewares/auth.middleware";
import { requireProfessional } from "../middlewares/permissions.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";

const router = Router();

//////////////////////////////////////////////////////
// PROFESSIONAL REGISTRATION / LOGIN (PHONE OTP)
//////////////////////////////////////////////////////

/**
 * Request OTP
 * Strict limiter -> prevents SMS abuse
 */
router.post(
  "/send-otp",
  rateLimiters.otpSend,
  sendProfessionalOtp
);

/**
 * Verify OTP
 * Relaxed limiter -> allows user mistakes
 */
router.post(
  "/verify-otp",
  rateLimiters.otpVerify,
  verifyProfessionalOtp
);

//////////////////////////////////////////////////////
// SESSION
//////////////////////////////////////////////////////

router.get(
  "/me",
  rateLimiters.authenticated,
  requireAuth,
  requireProfessional,
  getMeProfessional
);

export default router;
