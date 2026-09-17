type SecurityEvent =
  | "LOGIN_FAILED"
  | "USER_LOGIN"
  | "OTP_SENT"
  | "OTP_LIMIT"
  | "OTP_SEND_FAILED"
  | "OTP_VERIFY_FAILED"
  | "OTP_VERIFY_SUCCESS"
  | "UNAUTHORIZED_ACCESS"
  | "ADMIN_LOGIN"
  | "ACCOUNT_LOCKED";

export const securityLog = (
  event: SecurityEvent,
  data: Record<string, any>
) => {

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...data,
  };

  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[SECURITY]",
      JSON.stringify(payload)
    );
  } else {
    console.log(
      "[SECURITY]",
      payload
    );
  }
};
