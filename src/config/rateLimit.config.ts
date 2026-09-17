export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
}

export const RATE_LIMITS = {

  //////////////////////////////////////////////////
  // OTP SEND (SMS COST PROTECTION)
  //////////////////////////////////////////////////
  OTP_SEND: {
    windowMs: 60 * 1000,
    max: 3,
    message:
      "Too many OTP requests. Please wait.",
  },

  //////////////////////////////////////////////////
  // OTP VERIFY (ALLOW MISTAKES)
  //////////////////////////////////////////////////
  OTP_VERIFY: {
    windowMs: 60 * 1000,
    max: 10,
    message:
      "Too many verification attempts.",
  },

  //////////////////////////////////////////////////
  // ADMIN AUTH
  //////////////////////////////////////////////////
  ADMIN_AUTH: {
    windowMs: 60 * 1000,
    max: 3,
    message:
      "Admin authentication limited.",
  },

  //////////////////////////////////////////////////
  // EMAIL VERIFY
  //////////////////////////////////////////////////
  EMAIL_VERIFICATION: {
    windowMs: 60 * 60 * 1000,
    max: 5,
    message:
      "Too many verification requests.",
  },

  //////////////////////////////////////////////////
  // MEDIA UPLOAD (EXPENSIVE)
  //////////////////////////////////////////////////
  MEDIA_UPLOAD: {
    windowMs: 60 * 1000,
    max: 10,
    message:
      "Too many uploads. Slow down.",
  },

  //////////////////////////////////////////////////
  // AUTHENTICATED APIs
  //////////////////////////////////////////////////
  AUTHENTICATED: {
    windowMs: 60 * 1000,
    max: 60,
    message:
      "Too many requests.",
  },

  //////////////////////////////////////////////////
  // PROFESSIONAL LOCATION PINGS (battery/bandwidth protection)
  //////////////////////////////////////////////////
  LOCATION_UPDATE: {
    windowMs: 60 * 1000,
    max: 12,
    message:
      "Location updates are limited. Please slow down.",
  },

  //////////////////////////////////////////////////
  // PUBLIC APIs
  //////////////////////////////////////////////////
  PUBLIC: {
    windowMs: 60 * 1000,
    max: 100,
    message:
      "Rate limit exceeded.",
  },

  //////////////////////////////////////////////////
  // PHONEPE WEBHOOK (server-to-server, PhonePe retries on non-200)
  // Generous limit + IP-only key (no user identifier)
  //////////////////////////////////////////////////
  PHONEPE_WEBHOOK: {
    windowMs: 60 * 1000,
    max: 300,
    message:
      "Webhook rate limit exceeded.",
  },

} satisfies Record<string, RateLimitOptions>;