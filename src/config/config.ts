import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { normalizeIdentifier } from "../utils/identifier.util";

// Ensure production builds load `.env.production` by default when running from `dist/`.
// This avoids issues like verification links pointing to localhost in production.
const runtimeSource = __dirname.includes(
  `${path.sep}dist${path.sep}`
)
  ? "dist"
  : "src";

const rootDir = path.resolve(
  __dirname,
  "..",
  ".."
);

const dotenvOverridePath = (
  process.env.DOTENV_CONFIG_PATH ?? ""
).trim();

const candidatePaths: string[] = [];

if (dotenvOverridePath) {
  candidatePaths.push(
    path.isAbsolute(dotenvOverridePath)
      ? dotenvOverridePath
      : path.join(rootDir, dotenvOverridePath)
  );
}

if (
  process.env.NODE_ENV === "production" ||
  runtimeSource === "dist"
) {
  candidatePaths.push(
    path.join(rootDir, ".env.production")
  );
}

candidatePaths.push(path.join(rootDir, ".env"));

const selectedPath =
  candidatePaths.find((p) =>
    fs.existsSync(p)
  ) ?? undefined;

dotenv.config(
  selectedPath ? { path: selectedPath, override: true } : { override: true }
);

const normalizeNodeEnv = (
  value: string | undefined
) =>
  (value ?? "development")
    .trim()
    .toLowerCase();

const parseBoolean = (
  value: string | undefined,
  envName: string
) => {
  if (value == null || value.trim() === "") {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase();

  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes"
  ) {
    return true;
  }

  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no"
  ) {
    return false;
  }

  throw new Error(
    `${envName} must be one of: true/false/1/0/yes/no`
  );
};

const parseInteger = (
  value: string | undefined,
  envName: string
) => {
  if (value == null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(
      `${envName} must be an integer`
    );
  }

  return parsed;
};

const normalizeOrigin = (
  value: string
) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    // Fallback for non-URL values; keep behavior predictable.
    return trimmed.replace(/\/+$/, "");
  }
};

const parseOrigins = (
  value: string | undefined
) => {
  if (!value) {
    return [];
  }

  const normalized = value
    .split(",")
    .map((item) =>
      normalizeOrigin(item)
    )
    .filter(
      (origin): origin is string =>
        typeof origin ===
          "string" &&
        origin.length > 0
    );

  return Array.from(
    new Set(normalized)
  );
};

const NODE_ENV = normalizeNodeEnv(
  process.env.NODE_ENV
);

const databasePoolMax =
  parseInteger(
    process.env.DATABASE_POOL_MAX,
    "DATABASE_POOL_MAX"
  ) ??
  (NODE_ENV === "production"
    ? 10
    : 3);

if (databasePoolMax <= 0) {
  throw new Error(
    "DATABASE_POOL_MAX must be a positive integer"
  );
}

const databasePoolIdleTimeoutMs =
  parseInteger(
    process.env.DATABASE_POOL_IDLE_TIMEOUT_MS,
    "DATABASE_POOL_IDLE_TIMEOUT_MS"
  ) ?? 10_000;

if (databasePoolIdleTimeoutMs <= 0) {
  throw new Error(
    "DATABASE_POOL_IDLE_TIMEOUT_MS must be a positive integer"
  );
}

const databasePoolConnectionTimeoutMs =
  parseInteger(
    process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
    "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
  ) ?? 5_000;

if (
  databasePoolConnectionTimeoutMs <=
  0
) {
  throw new Error(
    "DATABASE_POOL_CONNECTION_TIMEOUT_MS must be a positive integer"
  );
}

const enableTrashCleanupJob =
  parseBoolean(
    process.env.ENABLE_TRASH_CLEANUP_JOB,
    "ENABLE_TRASH_CLEANUP_JOB"
  ) ?? (NODE_ENV === "production");

const enableNotificationCampaignScheduler =
  parseBoolean(
    process.env.ENABLE_NOTIFICATION_CAMPAIGN_SCHEDULER,
    "ENABLE_NOTIFICATION_CAMPAIGN_SCHEDULER"
  ) ?? (NODE_ENV === "production");

const enableAccountDeletionJob =
  parseBoolean(
    process.env.ENABLE_ACCOUNT_DELETION_JOB,
    "ENABLE_ACCOUNT_DELETION_JOB"
  ) ?? (NODE_ENV === "production");

const notificationCampaignSchedulerIntervalMs =
  parseInteger(
    process.env.NOTIFICATION_CAMPAIGN_SCHEDULER_INTERVAL_MS,
    "NOTIFICATION_CAMPAIGN_SCHEDULER_INTERVAL_MS"
  ) ?? 15_000;

if (
  notificationCampaignSchedulerIntervalMs <
  1_000
) {
  throw new Error(
    "NOTIFICATION_CAMPAIGN_SCHEDULER_INTERVAL_MS must be at least 1000"
  );
}

const accountDeletionJobIntervalMs =
  parseInteger(
    process.env.ACCOUNT_DELETION_JOB_INTERVAL_MS,
    "ACCOUNT_DELETION_JOB_INTERVAL_MS"
  ) ?? 60 * 60 * 1000;

if (accountDeletionJobIntervalMs < 60_000) {
  throw new Error(
    "ACCOUNT_DELETION_JOB_INTERVAL_MS must be at least 60000"
  );
}

const accountDeletionJobBatchSize =
  parseInteger(
    process.env.ACCOUNT_DELETION_JOB_BATCH_SIZE,
    "ACCOUNT_DELETION_JOB_BATCH_SIZE"
  ) ?? 25;

if (
  accountDeletionJobBatchSize <= 0 ||
  accountDeletionJobBatchSize > 100
) {
  throw new Error(
    "ACCOUNT_DELETION_JOB_BATCH_SIZE must be between 1 and 100"
  );
}

//////////////////////////////////////////////////////
// DISPATCH (PROFESSIONAL MATCHING)
//////////////////////////////////////////////////////

const enableDispatchSweepJob =
  parseBoolean(
    process.env.ENABLE_DISPATCH_SWEEP_JOB,
    "ENABLE_DISPATCH_SWEEP_JOB"
  ) ?? (NODE_ENV === "production");

const dispatchSweepIntervalMs =
  parseInteger(
    process.env.DISPATCH_SWEEP_INTERVAL_MS,
    "DISPATCH_SWEEP_INTERVAL_MS"
  ) ?? 60_000;

if (dispatchSweepIntervalMs < 10_000) {
  throw new Error(
    "DISPATCH_SWEEP_INTERVAL_MS must be at least 10000"
  );
}

const dispatchBatchSize =
  parseInteger(
    process.env.DISPATCH_BATCH_SIZE,
    "DISPATCH_BATCH_SIZE"
  ) ?? 3;

if (dispatchBatchSize <= 0 || dispatchBatchSize > 20) {
  throw new Error(
    "DISPATCH_BATCH_SIZE must be between 1 and 20"
  );
}

const dispatchOfferTtlMinutes =
  parseInteger(
    process.env.DISPATCH_OFFER_TTL_MINUTES,
    "DISPATCH_OFFER_TTL_MINUTES"
  ) ?? 5;

if (dispatchOfferTtlMinutes <= 0 || dispatchOfferTtlMinutes > 60) {
  throw new Error(
    "DISPATCH_OFFER_TTL_MINUTES must be between 1 and 60"
  );
}

// Hard ceiling regardless of an individual professional's configured
// serviceRadiusKm — mirrors the same cap idea used for branch service radius.
const dispatchMaxRadiusKm =
  parseInteger(
    process.env.DISPATCH_MAX_RADIUS_KM,
    "DISPATCH_MAX_RADIUS_KM"
  ) ?? 20;

if (dispatchMaxRadiusKm <= 0 || dispatchMaxRadiusKm > 100) {
  throw new Error(
    "DISPATCH_MAX_RADIUS_KM must be between 1 and 100"
  );
}

// Two bookings assigned to the same professional within this many minutes
// of each other are treated as a scheduling conflict.
const dispatchScheduleConflictBufferMinutes =
  parseInteger(
    process.env.DISPATCH_SCHEDULE_CONFLICT_BUFFER_MINUTES,
    "DISPATCH_SCHEDULE_CONFLICT_BUFFER_MINUTES"
  ) ?? 120;

if (
  dispatchScheduleConflictBufferMinutes <= 0 ||
  dispatchScheduleConflictBufferMinutes > 1440
) {
  throw new Error(
    "DISPATCH_SCHEDULE_CONFLICT_BUFFER_MINUTES must be between 1 and 1440"
  );
}

// A dispatch stuck IN_PROGRESS longer than this (e.g. the process crashed
// mid-round) is treated as abandoned and retried by the sweep job.
const dispatchStuckInProgressMinutes =
  parseInteger(
    process.env.DISPATCH_STUCK_IN_PROGRESS_MINUTES,
    "DISPATCH_STUCK_IN_PROGRESS_MINUTES"
  ) ?? 2;

if (
  dispatchStuckInProgressMinutes <= 0 ||
  dispatchStuckInProgressMinutes > 60
) {
  throw new Error(
    "DISPATCH_STUCK_IN_PROGRESS_MINUTES must be between 1 and 60"
  );
}

const clientUrl = (
  process.env.CLIENT_URL ?? ""
).trim();

const authGoogleEnabledRaw = (
  process.env.AUTH_GOOGLE_ENABLED ??
  process.env.GOOGLE_OAUTH_ENABLED ??
  ""
).trim();
const authGoogleEnabled =
  authGoogleEnabledRaw.toLowerCase() === "true";
const googleClientId = (
  process.env.GOOGLE_CLIENT_ID ??
  process.env.GOOGLE_OAUTH_CLIENT_ID ??
  ""
).trim();
const googleClientSecret = (
  process.env.GOOGLE_CLIENT_SECRET ??
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
  ""
).trim();
const googleCallbackUrl = (
  process.env.GOOGLE_CALLBACK_URL ??
  process.env.GOOGLE_OAUTH_CALLBACK_URL ??
  "http://localhost:5000/api/auth/google/callback"
).trim();

// Sign in with Apple (native iOS flow only — no Service ID/redirect flow,
// no private key needed here; the identity token's signature is verified
// against Apple's public JWKS).
const authAppleEnabledRaw = (
  process.env.AUTH_APPLE_ENABLED ?? ""
).trim();
const authAppleEnabled =
  authAppleEnabledRaw.toLowerCase() === "true";
const appleBundleId = (
  process.env.APPLE_BUNDLE_ID ??
  "in.sewaguru.app"
).trim();

const ALLOWED_ORIGINS = parseOrigins(
  process.env.ALLOWED_ORIGINS
);

if (
  NODE_ENV === "production" &&
  ALLOWED_ORIGINS.length === 0
) {
  throw new Error(
    "ALLOWED_ORIGINS is missing in .env for production"
  );
}

if (authGoogleEnabled) {
  if (!googleClientId) {
    throw new Error(
      "GOOGLE_CLIENT_ID is required while AUTH_GOOGLE_ENABLED=true"
    );
  }

  if (!googleClientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_SECRET is required while AUTH_GOOGLE_ENABLED=true"
    );
  }

  if (!googleCallbackUrl) {
    throw new Error(
      "GOOGLE_CALLBACK_URL is required while AUTH_GOOGLE_ENABLED=true"
    );
  }
}

// Optional safety checks (recommended)
if (!process.env.AWS_REGION) {
  throw new Error("AWS_REGION is missing in .env");
}

if (!process.env.AWS_S3_BUCKET_NAME) {
  throw new Error("AWS_S3_BUCKET_NAME is missing in .env");
}

if (!process.env.AWS_ACCESS_KEY_ID) {
  throw new Error("AWS_ACCESS_KEY_ID is missing in .env");
}

if (!process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error("AWS_SECRET_ACCESS_KEY is missing in .env");
}

// JWT should always be set in production
if (
  !process.env.JWT_SECRET &&
  NODE_ENV === "production"
) {
  throw new Error("JWT_SECRET is missing in .env for production");
}

const rapidSmsEnabledFromEnv = parseBoolean(
  process.env.RAPID_SMS_ENABLED,
  "RAPID_SMS_ENABLED"
);

const hasRapidSmsApiKey = Boolean(
  process.env.RAPID_SMS_API_KEY
);
const hasRapidSmsSenderId = Boolean(
  process.env.RAPID_SMS_SENDER_ID
);

if (
  hasRapidSmsApiKey !==
  hasRapidSmsSenderId
) {
  throw new Error(
    "RapidSMS configuration is incomplete. Set both RAPID_SMS_API_KEY and RAPID_SMS_SENDER_ID."
  );
}

const rapidSmsEnabled =
  rapidSmsEnabledFromEnv ??
  Boolean(
    hasRapidSmsApiKey &&
      hasRapidSmsSenderId
  );

const rapidSmsRoute = (
  process.env.RAPID_SMS_ROUTE ??
  "Trans"
).trim();

const otpExpiryMinutes =
  parseInteger(
    process.env.OTP_EXPIRY_MINUTES,
    "OTP_EXPIRY_MINUTES"
  ) ?? 10;

if (otpExpiryMinutes <= 0) {
  throw new Error(
    "OTP_EXPIRY_MINUTES must be a positive integer"
  );
}

// Test-account OTP bypass — for app store / play store review only. Lets one
// whitelisted email and/or phone log in with a fixed code instead of a real
// OTP, without touching real OTP generation/verification for any other
// identifier. Scoped by exact identifier match, not by NODE_ENV, since
// reviewers hit production.
const testOtpBypassEnabled =
  parseBoolean(
    process.env.TEST_OTP_BYPASS_ENABLED,
    "TEST_OTP_BYPASS_ENABLED"
  ) ?? false;

const testOtpBypassEmailRaw = (
  process.env.TEST_OTP_BYPASS_EMAIL ?? ""
).trim();
const testOtpBypassPhoneRaw = (
  process.env.TEST_OTP_BYPASS_PHONE ?? ""
).trim();
const testOtpBypassCode = (
  process.env.TEST_OTP_BYPASS_CODE ?? "111111"
).trim();

let testOtpBypassEmail = "";
let testOtpBypassPhone = "";

if (testOtpBypassEnabled) {
  if (!testOtpBypassEmailRaw && !testOtpBypassPhoneRaw) {
    throw new Error(
      "TEST_OTP_BYPASS_EMAIL or TEST_OTP_BYPASS_PHONE is required while TEST_OTP_BYPASS_ENABLED=true"
    );
  }

  if (!/^\d{4,8}$/.test(testOtpBypassCode)) {
    throw new Error(
      "TEST_OTP_BYPASS_CODE must be a 4-8 digit numeric code"
    );
  }

  if (testOtpBypassEmailRaw) {
    testOtpBypassEmail = normalizeIdentifier(
      testOtpBypassEmailRaw,
      "EMAIL"
    );
  }

  if (testOtpBypassPhoneRaw) {
    testOtpBypassPhone = normalizeIdentifier(
      testOtpBypassPhoneRaw,
      "PHONE"
    );
  }
}

const rapidSmsPeId = (
  process.env.RAPID_SMS_PE_ID ?? ""
).trim();

const rapidSmsTemplateId = (
  process.env.RAPID_SMS_TEMPLATE_ID ?? ""
).trim();

const rapidSmsTimeoutMsRaw = (
  process.env.RAPID_SMS_TIMEOUT_MS ?? ""
).trim();

const rapidSmsAllowInsecureTls =
  parseBoolean(
    process.env.RAPID_SMS_ALLOW_INSECURE_TLS,
    "RAPID_SMS_ALLOW_INSECURE_TLS"
  ) ?? false;

const rapidSmsTimeoutMs = rapidSmsTimeoutMsRaw
  ? Number(rapidSmsTimeoutMsRaw)
  : 10_000;

if (
  rapidSmsTimeoutMsRaw &&
  (!Number.isFinite(rapidSmsTimeoutMs) ||
    rapidSmsTimeoutMs <= 0)
) {
  throw new Error(
    "RAPID_SMS_TIMEOUT_MS must be a positive number"
  );
}

if (rapidSmsEnabled) {
  if (!process.env.RAPID_SMS_API_KEY) {
    throw new Error(
      "RAPID_SMS_API_KEY is missing while RAPID_SMS_ENABLED=true"
    );
  }

  if (!process.env.RAPID_SMS_SENDER_ID) {
    throw new Error(
      "RAPID_SMS_SENDER_ID is missing while RAPID_SMS_ENABLED=true"
    );
  }

  if (
    !/^[A-Za-z0-9]{6}$/.test(
      process.env.RAPID_SMS_SENDER_ID
    )
  ) {
    throw new Error(
      "RAPID_SMS_SENDER_ID must be a 6-character alphanumeric sender id."
    );
  }

  if (!rapidSmsRoute) {
    throw new Error(
      "RAPID_SMS_ROUTE is required while RAPID_SMS_ENABLED=true"
    );
  }

}

const paymentEnabled =
  parseBoolean(
    process.env.PAYMENT_ENABLED,
    "PAYMENT_ENABLED"
  ) ?? false;

const allowPayLater =
  parseBoolean(
    process.env.ALLOW_PAY_LATER,
    "ALLOW_PAY_LATER"
  ) ?? true;

const phonePeEnabledFromEnv = parseBoolean(
  process.env.PHONEPE_ENABLED,
  "PHONEPE_ENABLED"
);

const phonePeClientId = (
  process.env.PHONEPE_CLIENT_ID ?? ""
).trim();
const phonePeClientSecret = (
  process.env.PHONEPE_CLIENT_SECRET ??
  ""
).trim();
const phonePeClientVersionRaw = (
  process.env.PHONEPE_CLIENT_VERSION ??
  ""
).trim();
const phonePeCallbackUsername = (
  process.env.PHONEPE_CALLBACK_USERNAME ??
  ""
).trim();
const phonePeCallbackPassword = (
  process.env.PHONEPE_CALLBACK_PASSWORD ??
  ""
).trim();
const phonePeRedirectBaseUrl = (
  process.env.PHONEPE_REDIRECT_BASE_URL ??
  clientUrl
).trim();

const hasPhonePeCredentials = Boolean(
  phonePeClientId &&
    phonePeClientSecret &&
    phonePeClientVersionRaw
);

const phonePeEnabled =
  phonePeEnabledFromEnv ??
  hasPhonePeCredentials;
const phonePeCredentialsReady =
  hasPhonePeCredentials &&
  Boolean(phonePeCallbackUsername) &&
  Boolean(phonePeCallbackPassword) &&
  Boolean(phonePeRedirectBaseUrl);

const phonePeClientVersion =
  parseInteger(
    phonePeClientVersionRaw,
    "PHONEPE_CLIENT_VERSION"
  ) ?? 1;

const phonePeEnvRaw = (
  process.env.PHONEPE_ENV ??
  "SANDBOX"
)
  .trim()
  .toUpperCase();

if (
  phonePeEnvRaw !== "SANDBOX" &&
  phonePeEnvRaw !== "PRODUCTION"
) {
  throw new Error(
    "PHONEPE_ENV must be SANDBOX or PRODUCTION"
  );
}

if (phonePeEnabled) {
  if (!phonePeClientId) {
    throw new Error(
      "PHONEPE_CLIENT_ID is missing while PHONEPE_ENABLED=true"
    );
  }

  if (!phonePeClientSecret) {
    throw new Error(
      "PHONEPE_CLIENT_SECRET is missing while PHONEPE_ENABLED=true"
    );
  }

  if (
    !phonePeClientVersionRaw ||
    phonePeClientVersion <= 0
  ) {
    throw new Error(
      "PHONEPE_CLIENT_VERSION must be a positive integer while PHONEPE_ENABLED=true"
    );
  }

  if (!phonePeCallbackUsername) {
    throw new Error(
      "PHONEPE_CALLBACK_USERNAME is missing while PHONEPE_ENABLED=true"
    );
  }

  if (!phonePeCallbackPassword) {
    throw new Error(
      "PHONEPE_CALLBACK_PASSWORD is missing while PHONEPE_ENABLED=true"
    );
  }

  if (!phonePeRedirectBaseUrl) {
    throw new Error(
      "PHONEPE_REDIRECT_BASE_URL (or CLIENT_URL) is required while PHONEPE_ENABLED=true"
    );
  }
}


//////////////////////////////////////////////////////
// AUTH COOKIE
//////////////////////////////////////////////////////

const authCookieSameSiteRaw = (
  process.env.AUTH_COOKIE_SAMESITE ?? ""
)
  .trim()
  .toLowerCase();

if (
  authCookieSameSiteRaw &&
  authCookieSameSiteRaw !== "lax" &&
  authCookieSameSiteRaw !== "strict" &&
  authCookieSameSiteRaw !== "none"
) {
  throw new Error(
    "AUTH_COOKIE_SAMESITE must be one of: lax/strict/none"
  );
}

const authCookieSameSite = (authCookieSameSiteRaw ||
  (NODE_ENV === "production"
    ? "lax"
    : "lax")) as
  | "lax"
  | "strict"
  | "none";

//////////////////////////////////////////////////////
// EMAIL
//////////////////////////////////////////////////////

const emailEnabledFromEnv = parseBoolean(
  process.env.EMAIL_ENABLED,
  "EMAIL_ENABLED"
);

const emailProviderRaw = (
  process.env.EMAIL_PROVIDER ?? ""
)
  .trim()
  .toUpperCase();

const emailFrom = (
  process.env.EMAIL_FROM ?? ""
).trim();

const resendApiKey = (
  process.env.RESEND_API_KEY ?? ""
).trim();

const smtpHost = (
  process.env.SMTP_HOST ?? ""
).trim();

const smtpPortRaw = (
  process.env.SMTP_PORT ?? ""
).trim();

const smtpUser = (
  process.env.SMTP_USER ?? ""
).trim();

const smtpPass = (
  process.env.SMTP_PASS ?? ""
).trim();

const smtpSecure =
  parseBoolean(
    process.env.SMTP_SECURE,
    "SMTP_SECURE"
  ) ?? undefined;

const hasEmailFrom = Boolean(emailFrom);
const hasResendApiKey = Boolean(resendApiKey);

const hasSmtpHost = Boolean(smtpHost);
const hasSmtpUser = Boolean(smtpUser);
const hasSmtpPass = Boolean(smtpPass);
const hasSmtpPort = Boolean(smtpPortRaw);

const smtpPort =
  parseInteger(
    smtpPortRaw,
    "SMTP_PORT"
  ) ?? undefined;

const hasSmtpConfig = Boolean(
  hasSmtpHost &&
    hasSmtpUser &&
    hasSmtpPass &&
    smtpPort
);

const emailProvider = (emailProviderRaw ||
  (hasResendApiKey
    ? "RESEND"
    : hasSmtpConfig
    ? "SMTP"
    : "LOG")) as
  | "RESEND"
  | "SMTP"
  | "LOG";

if (
  emailProvider !== "RESEND" &&
  emailProvider !== "SMTP" &&
  emailProvider !== "LOG"
) {
  throw new Error(
    "EMAIL_PROVIDER must be RESEND, SMTP or LOG"
  );
}

// If provider is explicitly RESEND (or auto-selected via key presence) and not explicitly disabled,
// require full config at startup. This prevents "silent success" where email endpoints return 200
// but no email is actually deliverable.
if (
  emailProvider === "RESEND" &&
  emailEnabledFromEnv !== false
) {
  if (!hasEmailFrom || !hasResendApiKey) {
    throw new Error(
      "Email configuration is incomplete. Set both EMAIL_FROM and RESEND_API_KEY (or set EMAIL_ENABLED=false)."
    );
  }
}

if (
  emailProvider === "SMTP" &&
  emailEnabledFromEnv !== false
) {
  if (!hasEmailFrom || !hasSmtpConfig) {
    throw new Error(
      "Email configuration is incomplete. Set EMAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (or set EMAIL_ENABLED=false)."
    );
  }
}

const emailEnabled =
  emailEnabledFromEnv ??
  (emailProvider === "RESEND"
    ? Boolean(hasEmailFrom && hasResendApiKey)
    : emailProvider === "SMTP"
    ? Boolean(hasEmailFrom && hasSmtpConfig)
    : false);

if (emailEnabled) {
  if (emailProvider === "RESEND") {
    if (!hasEmailFrom) {
      throw new Error(
        "EMAIL_FROM is missing while EMAIL_ENABLED=true and EMAIL_PROVIDER=RESEND"
      );
    }

    if (!hasResendApiKey) {
      throw new Error(
        "RESEND_API_KEY is missing while EMAIL_ENABLED=true and EMAIL_PROVIDER=RESEND"
      );
    }
  }

  if (emailProvider === "SMTP") {
    if (!hasEmailFrom) {
      throw new Error(
        "EMAIL_FROM is missing while EMAIL_ENABLED=true and EMAIL_PROVIDER=SMTP"
      );
    }

    if (!hasSmtpHost) {
      throw new Error(
        "SMTP_HOST is missing while EMAIL_ENABLED=true and EMAIL_PROVIDER=SMTP"
      );
    }

    if (!smtpPort) {
      throw new Error(
        "SMTP_PORT is missing/invalid while EMAIL_ENABLED=true and EMAIL_PROVIDER=SMTP"
      );
    }

    if (!hasSmtpUser) {
      throw new Error(
        "SMTP_USER is missing while EMAIL_ENABLED=true and EMAIL_PROVIDER=SMTP"
      );
    }

    if (!hasSmtpPass) {
      throw new Error(
        "SMTP_PASS is missing while EMAIL_ENABLED=true and EMAIL_PROVIDER=SMTP"
      );
    }
  }

  if (
    NODE_ENV === "production" &&
    emailProvider === "LOG"
  ) {
    throw new Error(
      "EMAIL_PROVIDER=LOG is not allowed in production when EMAIL_ENABLED=true"
    );
  }

  if (!clientUrl) {
    throw new Error(
      "CLIENT_URL is required while EMAIL_ENABLED=true"
    );
  }
}

export const config = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 5000,
  NODE_ENV,
  DATABASE_POOL_MAX: databasePoolMax,
  DATABASE_POOL_IDLE_TIMEOUT_MS:
    databasePoolIdleTimeoutMs,
  DATABASE_POOL_CONNECTION_TIMEOUT_MS:
    databasePoolConnectionTimeoutMs,
  ENABLE_TRASH_CLEANUP_JOB:
    enableTrashCleanupJob,
  ENABLE_NOTIFICATION_CAMPAIGN_SCHEDULER:
    enableNotificationCampaignScheduler,
  ENABLE_ACCOUNT_DELETION_JOB:
    enableAccountDeletionJob,
  NOTIFICATION_CAMPAIGN_SCHEDULER_INTERVAL_MS:
    notificationCampaignSchedulerIntervalMs,
  ENABLE_DISPATCH_SWEEP_JOB:
    enableDispatchSweepJob,
  DISPATCH_SWEEP_INTERVAL_MS:
    dispatchSweepIntervalMs,
  DISPATCH_BATCH_SIZE:
    dispatchBatchSize,
  DISPATCH_OFFER_TTL_MINUTES:
    dispatchOfferTtlMinutes,
  DISPATCH_MAX_RADIUS_KM:
    dispatchMaxRadiusKm,
  DISPATCH_SCHEDULE_CONFLICT_BUFFER_MINUTES:
    dispatchScheduleConflictBufferMinutes,
  DISPATCH_STUCK_IN_PROGRESS_MINUTES:
    dispatchStuckInProgressMinutes,
  ACCOUNT_DELETION_JOB_INTERVAL_MS:
    accountDeletionJobIntervalMs,
  ACCOUNT_DELETION_JOB_BATCH_SIZE:
    accountDeletionJobBatchSize,
  TRUST_PROXY:
    parseBoolean(
      process.env.TRUST_PROXY,
      "TRUST_PROXY"
    ) ?? false,

  JWT_SECRET:
    NODE_ENV === "production"
      ? (process.env.JWT_SECRET as string)
      : process.env.JWT_SECRET ?? "dev-secret",

  ALLOWED_ORIGINS,
  CLIENT_URL: clientUrl,
  AUTH_GOOGLE_ENABLED: authGoogleEnabled,
  GOOGLE_CLIENT_ID: googleClientId,
  GOOGLE_CLIENT_SECRET: googleClientSecret,
  GOOGLE_CALLBACK_URL: googleCallbackUrl,

  AUTH_APPLE_ENABLED: authAppleEnabled,
  APPLE_BUNDLE_ID: appleBundleId,

  ACCESS_KEY: process.env.AWS_ACCESS_KEY_ID as string,
  SECRET_KEY: process.env.AWS_SECRET_ACCESS_KEY as string,
  REGION: process.env.AWS_REGION as string,
  BUCKET: process.env.AWS_S3_BUCKET_NAME as string,

  AUTH_COOKIE_DOMAIN:
    (process.env.AUTH_COOKIE_DOMAIN ?? "")
      .trim() ||
    ".sewaguru.in",
  AUTH_COOKIE_SAMESITE: authCookieSameSite,

  EMAIL_ENABLED: emailEnabled,
  EMAIL_PROVIDER: emailProvider,
  EMAIL_FROM: emailFrom,
  RESEND_API_KEY: resendApiKey,

  SMTP_HOST: smtpHost,
  SMTP_PORT: smtpPort ?? 0,
  SMTP_USER: smtpUser,
  SMTP_PASS: smtpPass,
  SMTP_SECURE: smtpSecure,

  RAPID_SMS_ENABLED: rapidSmsEnabled,
  RAPID_SMS_BASE_URL:
    process.env.RAPID_SMS_BASE_URL ??
    "https://1.rapidsms.co.in/api/push",
  RAPID_SMS_API_KEY:
    process.env.RAPID_SMS_API_KEY ?? "",
  RAPID_SMS_ROUTE: rapidSmsRoute,
  RAPID_SMS_SENDER_ID:
    process.env.RAPID_SMS_SENDER_ID ?? "",
  RAPID_SMS_PE_ID: rapidSmsPeId,
  RAPID_SMS_TEMPLATE_ID: rapidSmsTemplateId,
  RAPID_SMS_TIMEOUT_MS: rapidSmsTimeoutMs,
  RAPID_SMS_ALLOW_INSECURE_TLS:
    rapidSmsAllowInsecureTls,
  RAPID_SMS_OTP_MESSAGE:
    process.env.RAPID_SMS_OTP_MESSAGE ?? "",
  OTP_EXPIRY_MINUTES: otpExpiryMinutes,

  TEST_OTP_BYPASS_ENABLED: testOtpBypassEnabled,
  TEST_OTP_BYPASS_EMAIL: testOtpBypassEmail,
  TEST_OTP_BYPASS_PHONE: testOtpBypassPhone,
  TEST_OTP_BYPASS_CODE: testOtpBypassCode,

  PAYMENT_ENABLED: paymentEnabled,
  ALLOW_PAY_LATER: allowPayLater,

  PHONEPE_ENABLED: phonePeEnabled,
  PHONEPE_CREDENTIALS_READY:
    phonePeCredentialsReady,
  PHONEPE_CLIENT_ID: phonePeClientId,
  PHONEPE_CLIENT_SECRET: phonePeClientSecret,
  PHONEPE_CLIENT_VERSION: phonePeClientVersion,
  PHONEPE_ENV: phonePeEnvRaw as
    | "SANDBOX"
    | "PRODUCTION",
  PHONEPE_CALLBACK_USERNAME:
    phonePeCallbackUsername,
  PHONEPE_CALLBACK_PASSWORD:
    phonePeCallbackPassword,
  PHONEPE_REDIRECT_BASE_URL:
    phonePeRedirectBaseUrl,
};
