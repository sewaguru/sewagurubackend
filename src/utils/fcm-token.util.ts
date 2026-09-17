const APNS_TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
const APNS_TOKEN_INPUT_PATTERN = /^[0-9a-fA-F<>\s]+$/;
const WHITESPACE_PATTERN = /\s/;

export const normalizeDeviceToken = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export const maskDeviceToken = (token: string) =>
  token.length <= 18
    ? token
    : `${token.slice(0, 12)}...${token.slice(-6)}`;

export const looksLikeApnsDeviceToken = (
  token: string,
) => {
  const compact = token.replace(/[<>\s]/g, "");

  return (
    compact.length === 64 &&
    APNS_TOKEN_PATTERN.test(compact) &&
    APNS_TOKEN_INPUT_PATTERN.test(token)
  );
};

export const getFcmRegistrationTokenValidationError = (
  token: string,
) => {
  if (!token) {
    return "token is required";
  }

  if (looksLikeApnsDeviceToken(token)) {
    return "The provided token looks like an Apple APNs device token. Send the Firebase FCM registration token from FirebaseMessaging.getToken() instead.";
  }

  if (WHITESPACE_PATTERN.test(token)) {
    return "The FCM registration token must not contain spaces or line breaks. Paste the exact token returned by FirebaseMessaging.getToken().";
  }

  return null;
};

export const isInvalidFcmRegistrationTokenError = (
  code?: string,
  message?: string,
) => {
  const normalizedMessage = message ?? "";

  return (
    code === "messaging/invalid-registration-token" ||
    code === "messaging/registration-token-not-registered" ||
    ((code === "messaging/invalid-argument" ||
      code === "messaging/invalid-recipient" ||
      !code) &&
      /registration token .*not a valid FCM registration token|invalid registration token/i.test(
        normalizedMessage,
      ))
  );
};
