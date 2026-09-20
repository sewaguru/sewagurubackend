import { config } from "../config/config";
import { AppError } from "../utils/AppError";
import nodemailer, { type Transporter } from "nodemailer";

type EmailProvider = "RESEND" | "SMTP" | "LOG";

const RESEND_API_URL = "https://api.resend.com/emails";

const getProvider = (): EmailProvider =>
  config.EMAIL_PROVIDER as EmailProvider;

export const assertEmailProviderReady = (): void => {
  if (!config.EMAIL_ENABLED) {
    throw new AppError(
      "Email service is not configured",
      503,
      "EMAIL_DISABLED"
    );
  }

  const provider = getProvider();

  if (provider === "LOG") {
    throw new AppError(
      "Email service is not configured",
      503,
      "EMAIL_DISABLED"
    );
  }

  if (provider === "RESEND") {
    if (!config.EMAIL_FROM || !config.RESEND_API_KEY) {
      throw new AppError(
        "Email provider configuration is missing",
        500,
        "EMAIL_CONFIG_MISSING"
      );
    }
    return;
  }

  if (provider === "SMTP") {
    if (
      !config.EMAIL_FROM ||
      !config.SMTP_HOST ||
      !config.SMTP_PORT ||
      !config.SMTP_USER ||
      !config.SMTP_PASS
    ) {
      throw new AppError(
        "Email provider configuration is missing",
        500,
        "EMAIL_CONFIG_MISSING"
      );
    }
    return;
  }

  throw new AppError(
    "Unsupported email provider",
    500,
    "EMAIL_PROVIDER_UNSUPPORTED"
  );
};

let smtpTransport:
  | Transporter
  | null = null;

const getSmtpTransporter = () => {
  if (smtpTransport) return smtpTransport;

  const host = config.SMTP_HOST;
  const port = config.SMTP_PORT;
  const user = config.SMTP_USER;
  const pass = config.SMTP_PASS;
  const secure =
    config.SMTP_SECURE ??
    Number(port) === 465;

  if (!host || !port || !user || !pass) {
    throw new AppError(
      "Email provider configuration is missing",
      500,
      "EMAIL_CONFIG_MISSING"
    );
  }

  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    // Fail fast when SMTP is unreachable (common in restricted networks / firewalls).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return smtpTransport;
};

type SmtpErrorDetails = {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
};

const getSmtpErrorDetails = (
  err: unknown
): SmtpErrorDetails => {
  if (
    typeof err !== "object" ||
    err === null
  ) {
    return {};
  }

  const anyErr = err as Record<
    string,
    unknown
  >;

  const details: SmtpErrorDetails = {};

  if (typeof anyErr.code === "string") {
    details.code = anyErr.code;
  }

  if (typeof anyErr.responseCode === "number") {
    details.responseCode = anyErr.responseCode;
  }

  if (typeof anyErr.response === "string") {
    details.response = anyErr.response;
  }

  if (typeof anyErr.command === "string") {
    details.command = anyErr.command;
  }

  return details;
};

export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
  text?: string
): Promise<void> => {
  if (!config.EMAIL_ENABLED) {
    throw new AppError(
      "Email service is not configured",
      503,
      "EMAIL_DISABLED"
    );
  }
  const provider = getProvider();

  if (provider === "LOG") {
    // Useful for local/dev environments; never use in real production.
    console.log("[EMAIL][LOG]", {
      to,
      subject,
    });
    return;
  }

  if (provider === "RESEND") {
    const apiKey = config.RESEND_API_KEY;
    const from = config.EMAIL_FROM;

    if (!apiKey || !from) {
      throw new AppError(
        "Email provider configuration is missing",
        500,
        "EMAIL_CONFIG_MISSING"
      );
    } 

    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          html,
          ...(text ? { text } : {}),
        }),
      });
    } catch (err) {
      console.error("[EMAIL][RESEND][NETWORK_ERROR]", {
        to,
        subject,
        error:
          err instanceof Error
            ? err.message
            : String(err),
      });
      throw new AppError(
        "Failed to send email",
        502,
        "EMAIL_SEND_FAILED"
      );
    }

    if (!response.ok) {
      let details: unknown = null;
      try {
        details = await response.json();
      } catch {
        try {
          details = await response.text();
        } catch {
          details = null;
        }
      }

      console.error("[EMAIL][RESEND][ERROR]", {
        to,
        subject,
        status: response.status,
        details,
      });

      throw new AppError(
        "Failed to send email",
        502,
        "EMAIL_SEND_FAILED"
      );
    }

    return;
  }

  if (provider === "SMTP") {
    const from = config.EMAIL_FROM;

    if (!from) {
      throw new AppError(
        "Email provider configuration is missing",
        500,
        "EMAIL_CONFIG_MISSING"
      );
    }

    const transporter =
      getSmtpTransporter();

    try {
      const sendMailPromise =
        transporter.sendMail({
          from,
          to,
          subject,
          html,
          ...(text ? { text } : {}),
        });

      // Some environments (firewalls/hosting) can hang indefinitely on SMTP connect.
      // Put a hard upper bound so OTP/verification routes never stall.
      const smtpHardTimeoutMs = 15_000;

      let timeoutHandle: NodeJS.Timeout | null =
        null;

      const info = await Promise.race([
        sendMailPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            try {
              transporter.close();
            } catch {
              // ignore
            }

            reject(
              new AppError(
                "SMTP request timed out. Please check outbound SMTP access (ports 465/587).",
                502,
                "EMAIL_SMTP_TIMEOUT"
              )
            );
          }, smtpHardTimeoutMs);
        }),
      ]).finally(() => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      });

      const accepted = Array.isArray(info.accepted)
        ? info.accepted
        : [];
      const rejected = Array.isArray(info.rejected)
        ? info.rejected
        : [];

      // If the SMTP server didn't accept any recipients, treat it as a failure.
      if (accepted.length === 0) {
        console.error("[EMAIL][SMTP][REJECTED]", {
          to,
          subject,
          accepted,
          rejected,
          response: info.response,
        });

        throw new AppError(
          "Email was rejected by the SMTP server. Please verify the recipient address and SMTP settings.",
          502,
          "EMAIL_RECIPIENT_REJECTED"
        );
      }

      // Useful for tracing delivery issues; doesn't include email content.
      if (config.NODE_ENV !== "production") {
        console.log("[EMAIL][SMTP][SENT]", {
          to,
          subject,
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
        });
      }
    } catch (err) {
      if (err instanceof AppError) {
        // Keep explicit operational errors intact (timeouts, disabled providers, etc.)
        throw err;
      }

      const details =
        getSmtpErrorDetails(err);

      console.error("[EMAIL][SMTP][ERROR]", {
        to,
        subject,
        ...details,
        error:
          err instanceof Error
            ? err.message
            : String(err),
      });

      // Common misconfig: wrong credentials (Titan/GoDaddy will return 535/EAUTH).
      if (
        details.code === "EAUTH" ||
        details.responseCode === 535
      ) {
        throw new AppError(
          "SMTP authentication failed. Please verify SMTP_USER/SMTP_PASS. If you're using GoDaddy Titan with 2-step verification, use an app password.",
          502,
          "EMAIL_SMTP_AUTH_FAILED"
        );
      }

      throw new AppError(
        "Failed to send email via SMTP",
        502,
        "EMAIL_SEND_FAILED"
      );
    }

    return;
  }

  throw new AppError(
    "Unsupported email provider",
    500,
    "EMAIL_PROVIDER_UNSUPPORTED"
  );
};
