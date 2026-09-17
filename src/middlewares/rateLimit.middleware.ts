import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { RATE_LIMITS } from "../config/rateLimit.config";

//////////////////////////////////////////////////////
// SAFE KEY GENERATOR ⭐
//////////////////////////////////////////////////////
const keyGenerator = (req: any) => {

  const identifier =
    req.body?.identifier ||
    req.user?.id ||
    "anon";

  const ipKey = ipKeyGenerator(req);

  return `${ipKey}-${identifier}`;
};

//////////////////////////////////////////////////////
// FACTORY
//////////////////////////////////////////////////////
const createLimiter = (
  config: typeof RATE_LIMITS[keyof typeof RATE_LIMITS]
) =>
  rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    keyGenerator,

    standardHeaders: true,
    legacyHeaders: false,

    handler: (_, res) => {
      res.status(429).json({
        success: false,
        message: config.message,
      });
    },
  });

//////////////////////////////////////////////////////
// EXPORTS
//////////////////////////////////////////////////////
export const rateLimiters = {

  otpSend: createLimiter(
    RATE_LIMITS.OTP_SEND
  ),

  otpVerify: createLimiter(
    RATE_LIMITS.OTP_VERIFY
  ),

  adminAuth: createLimiter(
    RATE_LIMITS.ADMIN_AUTH
  ),

  emailVerification: createLimiter(
    RATE_LIMITS.EMAIL_VERIFICATION
  ),

  mediaUpload: createLimiter(
    RATE_LIMITS.MEDIA_UPLOAD
  ),

  authenticated: createLimiter(
    RATE_LIMITS.AUTHENTICATED
  ),

  locationUpdate: createLimiter(
    RATE_LIMITS.LOCATION_UPDATE
  ),

  public: createLimiter(
    RATE_LIMITS.PUBLIC
  ),

  // IP-only key: PhonePe has no user identifier, retries on non-200
  phonePeWebhook: rateLimit({
    windowMs: RATE_LIMITS.PHONEPE_WEBHOOK.windowMs,
    max: RATE_LIMITS.PHONEPE_WEBHOOK.max,
    keyGenerator: (req: any) => ipKeyGenerator(req),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_, res) => {
      res.status(429).json({
        success: false,
        message: RATE_LIMITS.PHONEPE_WEBHOOK.message,
      });
    },
  }),
};