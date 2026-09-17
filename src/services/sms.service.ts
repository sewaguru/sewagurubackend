import http from "http";
import https from "https";
import { config } from "../config/config";
import { AppError } from "../utils/AppError";

const OTP_PLACEHOLDER_REGEX =
  /{{\s*OTP\s*}}/g;

const maskPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
};

// Strips the API key and OTP message text before a gateway request URL is
// ever written to logs — both were previously logged in full on failure.
const redactSmsUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("apikey")) {
      parsed.searchParams.set("apikey", "***REDACTED***");
    }
    if (parsed.searchParams.has("text")) {
      parsed.searchParams.set("text", "***REDACTED***");
    }
    return parsed.toString();
  } catch {
    return "<unparseable-url>";
  }
};

const normalizeIndianPhoneNumber = (
  phone: string
) => {
  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) {
    return digits;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("0")
  ) {
    return digits.slice(1);
  }

  if (
    digits.length === 12 &&
    digits.startsWith("91")
  ) {
    return digits.slice(2);
  }

  throw new AppError(
    "Invalid phone number",
    400,
    "INVALID_PHONE"
  );
};

const buildOtpMessage = (otp: string) => {
  const template =
    config.RAPID_SMS_OTP_MESSAGE ||
    `Your Login OTP is {{OTP}}. This code is valid for ${config.OTP_EXPIRY_MINUTES} minutes. Do not share this code with anyone.`;

  if (template.includes("{{OTP}}")) {
    return template.replace(
      OTP_PLACEHOLDER_REGEX,
      otp
    );
  }

  return `${template} ${otp}`.trim();
};

type FetchFailureDetails = {
  errorName?: string;
  errorMessage?: string;
  causeName?: string;
  causeMessage?: string;
  causeCode?: string;
  causeErrno?: string | number;
  causeSyscall?: string;
  causeAddress?: string;
  causePort?: number;
};

const getFetchFailureDetails = (
  error: unknown
): FetchFailureDetails => {
  if (
    typeof error !== "object" ||
    error === null
  ) {
    return {};
  }

  const anyErr = error as Record<
    string,
    unknown
  >;

  const details: FetchFailureDetails = {};

  if (typeof anyErr.name === "string") {
    details.errorName = anyErr.name;
  }

  if (typeof anyErr.message === "string") {
    details.errorMessage = anyErr.message;
  }

  const cause = anyErr.cause;
  if (
    typeof cause === "object" &&
    cause !== null
  ) {
    const anyCause = cause as Record<
      string,
      unknown
    >;

    if (typeof anyCause.name === "string") {
      details.causeName = anyCause.name;
    }
    if (
      typeof anyCause.message === "string"
    ) {
      details.causeMessage = anyCause.message;
    }
    if (typeof anyCause.code === "string") {
      details.causeCode = anyCause.code;
    }
    if (
      typeof anyCause.errno === "string" ||
      typeof anyCause.errno === "number"
    ) {
      details.causeErrno = anyCause.errno;
    }
    if (
      typeof anyCause.syscall === "string"
    ) {
      details.causeSyscall = anyCause.syscall;
    }
    if (
      typeof anyCause.address === "string"
    ) {
      details.causeAddress = anyCause.address;
    }
    if (typeof anyCause.port === "number") {
      details.causePort = anyCause.port;
    }
  }

  return details;
};

const isFailureText = (body: string) => {
  const value = body.toLowerCase();

  return (
    value.includes("error") ||
    value.includes("failed") ||
    value.includes("invalid") ||
    value.includes("unauthorized")
  );
};

const hasSuccessText = (body: string) => {
  const value = body.toLowerCase();

  return (
    value.includes("success") ||
    value.includes("submitted") ||
    value.includes("queued") ||
    value.includes("batch")
  );
};

const isObjectRecord = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null;

const isFailurePayload = (
  payload: Record<string, unknown>
) => {
  const status = String(
    payload.status ?? ""
  ).toLowerCase();

  const message = String(
    payload.message ??
      payload.error ??
      ""
  ).toLowerCase();

  if (payload.error) return true;

  if (
    status === "false" ||
    status === "0" ||
    status === "failed" ||
    status === "error"
  ) {
    return true;
  }

  return (
    message.includes("error") ||
    message.includes("failed") ||
    message.includes("invalid") ||
    message.includes("unauthorized") ||
    message.includes("forbidden")
  );
};

const hasSuccessPayload = (
  payload: Record<string, unknown>
) => {
  const status = String(
    payload.status ??
      payload.response ??
      ""
  ).toLowerCase();

  const message = String(
    payload.message ??
      ""
  ).toLowerCase();

  if (
    typeof payload.batchid ===
      "string" &&
    payload.batchid.trim()
  ) {
    return true;
  }

  return (
    status === "true" ||
    status === "1" ||
    status === "success" ||
    status === "ok" ||
    status === "queued" ||
    message.includes("success") ||
    message.includes("submitted") ||
    message.includes("queued")
  );
};

export const assertSmsProviderReady = () => {
  if (!config.RAPID_SMS_ENABLED) {
    throw new AppError(
      "SMS delivery is disabled. Set RAPID_SMS_ENABLED=true",
      503,
      "SMS_DISABLED"
    );
  }

  if (
    !config.RAPID_SMS_API_KEY ||
    !config.RAPID_SMS_SENDER_ID
  ) {
    throw new AppError(
      "SMS gateway is not configured",
      500,
      "SMS_NOT_CONFIGURED"
    );
  }
};

const debugSmsFailure = (
  data: Record<string, unknown>
) => {
  console.error("[RapidSMS][FAIL]", data);
};

const requestSmsGateway = (
  url: string
) =>
  new Promise<{
    statusCode: number;
    body: string;
  }>((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client =
      parsedUrl.protocol === "http:"
        ? http
        : https;

    const request = client.request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          Accept: "*/*",
        },
        timeout: config.RAPID_SMS_TIMEOUT_MS,
        ...(parsedUrl.protocol === "https:"
          ? {
              rejectUnauthorized:
                !config.RAPID_SMS_ALLOW_INSECURE_TLS,
            }
          : {}),
      },
      (response) => {
        let data = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode:
              response.statusCode ?? 0,
            body: data.trim(),
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error(
          "SMS gateway request timed out"
        )
      );
    });

    request.on("error", (error) => {
      reject(error);
    });

    request.end();
  });

export const sendOtpSms = async (
  phone: string,
  otp: string
) => {
  assertSmsProviderReady();

  const to = normalizeIndianPhoneNumber(phone);
  const message = buildOtpMessage(otp);

  const params = new URLSearchParams({
    apikey: config.RAPID_SMS_API_KEY,
    route: config.RAPID_SMS_ROUTE,
    sender: config.RAPID_SMS_SENDER_ID,
    mobileno: to,
    text: message,
  });

  if (config.RAPID_SMS_PE_ID) {
    params.set("peid", config.RAPID_SMS_PE_ID);
    // Some DLT gateways use `entityid` for PE ID.
    params.set("entityid", config.RAPID_SMS_PE_ID);
  }

  if (config.RAPID_SMS_TEMPLATE_ID) {
    params.set(
      "templateid",
      config.RAPID_SMS_TEMPLATE_ID
    );
    // Some DLT gateways use `tempid` for template id.
    params.set("tempid", config.RAPID_SMS_TEMPLATE_ID);
  }

  const requestUrl = `${config.RAPID_SMS_BASE_URL}?${params.toString()}`;
  let statusCode = 0;
  let rawResponse = "";

  try {
    const response =
      await requestSmsGateway(
        requestUrl
      );
    statusCode = response.statusCode;
    rawResponse = response.body;
  } catch (error) {
    debugSmsFailure({
      reason: "network_error",
      route: config.RAPID_SMS_ROUTE,
      sender: config.RAPID_SMS_SENDER_ID,
      mobile: maskPhone(to),
      requestUrl: redactSmsUrl(requestUrl),
      insecureTls:
        config.RAPID_SMS_ALLOW_INSECURE_TLS,
      response:
        error instanceof Error
          ? error.message
          : "unknown",
      ...getFetchFailureDetails(error),
    });

    throw new AppError(
      "Failed to reach SMS gateway. Please check SMS gateway connectivity and TLS configuration.",
      502,
      "SMS_GATEWAY_UNREACHABLE"
    );
  }

  if (
    statusCode < 200 ||
    statusCode >= 300 ||
    !rawResponse
  ) {
    debugSmsFailure({
      reason: "non_ok_response",
      statusCode: String(statusCode),
      route: config.RAPID_SMS_ROUTE,
      sender: config.RAPID_SMS_SENDER_ID,
      mobile: maskPhone(to),
      requestUrl: redactSmsUrl(requestUrl),
      response: rawResponse || "<empty>",
    });

    throw new AppError(
      "Failed to send OTP SMS",
      502,
      "SMS_SEND_FAILED"
    );
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawResponse);
  } catch {
    // Some providers return plain text or a batch id.
    if (
      rawResponse &&
      !isFailureText(rawResponse)
    ) {
      return rawResponse;
    }

    debugSmsFailure({
      reason: "invalid_json_response",
      route: config.RAPID_SMS_ROUTE,
      sender: config.RAPID_SMS_SENDER_ID,
      mobile: maskPhone(to),
      response: rawResponse,
    });

    throw new AppError(
      "Failed to send OTP SMS",
      502,
      "SMS_SEND_FAILED"
    );
  }

  if (!isObjectRecord(payload)) {
    debugSmsFailure({
      reason: "invalid_payload_shape",
      route: config.RAPID_SMS_ROUTE,
      sender: config.RAPID_SMS_SENDER_ID,
      mobile: maskPhone(to),
      response: rawResponse,
    });

    throw new AppError(
      "Failed to send OTP SMS",
      502,
      "SMS_SEND_FAILED"
    );
  }

  if (
    isFailurePayload(payload) ||
    (isFailureText(rawResponse) &&
      !hasSuccessText(rawResponse))
  ) {
    debugSmsFailure({
      reason: "failure_payload",
      route: config.RAPID_SMS_ROUTE,
      sender: config.RAPID_SMS_SENDER_ID,
      mobile: maskPhone(to),
      response: rawResponse,
    });

    throw new AppError(
      "Failed to send OTP SMS",
      502,
      "SMS_SEND_FAILED"
    );
  }

  if (!hasSuccessPayload(payload)) {
    debugSmsFailure({
      reason: "unknown_payload_status",
      route: config.RAPID_SMS_ROUTE,
      sender: config.RAPID_SMS_SENDER_ID,
      mobile: maskPhone(to),
      response: rawResponse,
    });

    throw new AppError(
      "Failed to send OTP SMS",
      502,
      "SMS_SEND_FAILED"
    );
  }

  if (typeof payload.batchid === "string") {
    return payload.batchid;
  }

  return rawResponse;
};
