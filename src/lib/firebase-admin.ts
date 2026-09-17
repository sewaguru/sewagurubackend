import * as admin from "firebase-admin";

export type FirebaseCredentialSource =
  | "SERVICE_ACCOUNT_JSON"
  | "ENV_FIELDS"
  | "NONE";

export type FirebaseAdminDiagnostics = {
  configured: boolean;
  ready: boolean;
  initialized: boolean;
  projectId: string | null;
  credentialSource: FirebaseCredentialSource;
  errorMessage: string | null;
  env: {
    hasServiceAccountJson: boolean;
    hasProjectId: boolean;
    hasClientEmail: boolean;
    hasPrivateKey: boolean;
  };
};

let cachedApp: admin.app.App | null = null;
let initialized = false;
let lastInitError: string | null = null;
let warnedConfigIssue = false;

type FirebaseServiceAccountJson =
  Record<string, unknown>;

const readEnv = (key: string) => {
  const raw = process.env[key];
  if (typeof raw !== "string") {
    return "";
  }

  return raw.trim();
};

const normalizePrivateKey = (value: string) =>
  value.replace(/\\n/g, "\n").trim();

const readJsonString = (
  payload: FirebaseServiceAccountJson,
  ...keys: string[]
) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
};

const getEnvPresence = () => ({
  hasServiceAccountJson: Boolean(
    readEnv("FIREBASE_SERVICE_ACCOUNT_JSON"),
  ),
  hasProjectId: Boolean(
    readEnv("FIREBASE_PROJECT_ID"),
  ),
  hasClientEmail: Boolean(
    readEnv("FIREBASE_CLIENT_EMAIL"),
  ),
  hasPrivateKey: Boolean(
    readEnv("FIREBASE_PRIVATE_KEY"),
  ),
});

const buildSplitEnvServiceAccount = () => {
  const projectId = readEnv("FIREBASE_PROJECT_ID");
  const clientEmail = readEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = normalizePrivateKey(
    readEnv("FIREBASE_PRIVATE_KEY"),
  );

  if (!projectId && !clientEmail && !privateKey) {
    return {
      serviceAccount: null,
      credentialSource: "NONE" as const,
      errorMessage: null,
      projectId: null,
    };
  }

  if (!projectId || !clientEmail || !privateKey) {
    return {
      serviceAccount: null,
      credentialSource: "ENV_FIELDS" as const,
      errorMessage:
        "Firebase Admin credentials are incomplete. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.",
      projectId: projectId || null,
    };
  }

  return {
    serviceAccount: {
      projectId,
      clientEmail,
      privateKey,
    } satisfies admin.ServiceAccount,
    credentialSource: "ENV_FIELDS" as const,
    errorMessage: null,
    projectId,
  };
};

const resolveServiceAccount = () => {
  const rawJson = readEnv(
    "FIREBASE_SERVICE_ACCOUNT_JSON",
  );
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null
      ) {
        return {
          serviceAccount: null,
          credentialSource:
            "SERVICE_ACCOUNT_JSON" as const,
          errorMessage:
            "FIREBASE_SERVICE_ACCOUNT_JSON must be a JSON object.",
          projectId: null,
        };
      }

      const payload =
        parsed as FirebaseServiceAccountJson;
      const projectId = readJsonString(
        payload,
        "projectId",
        "project_id",
      );
      const clientEmail = readJsonString(
        payload,
        "clientEmail",
        "client_email",
      );
      const privateKey = normalizePrivateKey(
        readJsonString(
          payload,
          "privateKey",
          "private_key",
        ),
      );

      if (!projectId || !clientEmail || !privateKey) {
        return {
          serviceAccount: null,
          credentialSource:
            "SERVICE_ACCOUNT_JSON" as const,
          errorMessage:
            "FIREBASE_SERVICE_ACCOUNT_JSON is present but missing projectId, clientEmail, or privateKey.",
          projectId: projectId || null,
        };
      }

      return {
        serviceAccount: {
          projectId,
          clientEmail,
          privateKey,
        } satisfies admin.ServiceAccount,
        credentialSource:
          "SERVICE_ACCOUNT_JSON" as const,
        errorMessage: null,
        projectId,
      };
    } catch (error) {
      return {
        serviceAccount: null,
        credentialSource:
          "SERVICE_ACCOUNT_JSON" as const,
        errorMessage:
          error instanceof Error
            ? `FIREBASE_SERVICE_ACCOUNT_JSON could not be parsed: ${error.message}`
            : "FIREBASE_SERVICE_ACCOUNT_JSON could not be parsed.",
        projectId: null,
      };
    }
  }

  return buildSplitEnvServiceAccount();
};

const warnConfig = (message: string) => {
  if (warnedConfigIssue) {
    return;
  }

  warnedConfigIssue = true;
  console.warn(
    "[Push] Firebase Admin is not ready:",
    message,
  );
};

const ensureFirebaseAdminApp = () => {
  if (cachedApp) {
    return cachedApp;
  }

  const resolved = resolveServiceAccount();
  if (!resolved.serviceAccount) {
    lastInitError = resolved.errorMessage;
    if (resolved.errorMessage) {
      warnConfig(resolved.errorMessage);
    }
    return null;
  }

  try {
    cachedApp =
      admin.apps.length > 0
        ? admin.app()
        : admin.initializeApp({
            credential: admin.credential.cert(
              resolved.serviceAccount,
            ),
            projectId:
              resolved.serviceAccount.projectId,
          });
    initialized = true;
    lastInitError = null;

    console.info(
      "[Push] Firebase Admin initialized.",
      {
        projectId:
          resolved.serviceAccount.projectId,
        credentialSource:
          resolved.credentialSource,
      },
    );
    return cachedApp;
  } catch (error) {
    lastInitError =
      error instanceof Error
        ? error.message
        : "Firebase Admin initialization failed.";
    console.error(
      "[Push] Firebase Admin initialization failed.",
      error,
    );
    return null;
  }
};

export const getFirebaseMessaging = (): admin.messaging.Messaging | null => {
  const app = ensureFirebaseAdminApp();
  if (!app) {
    return null;
  }

  return app.messaging();
};

export const getFirebaseAdminDiagnostics = ({
  initialize = false,
}: {
  initialize?: boolean;
} = {}): FirebaseAdminDiagnostics => {
  if (initialize) {
    ensureFirebaseAdminApp();
  }

  const resolved = resolveServiceAccount();
  const configured = Boolean(resolved.serviceAccount);
  const ready = Boolean(cachedApp) && !lastInitError;

  return {
    configured,
    ready,
    initialized,
    projectId: resolved.projectId,
    credentialSource: resolved.credentialSource,
    errorMessage:
      lastInitError ?? resolved.errorMessage,
    env: getEnvPresence(),
  };
};

export const isFirebaseAdminConfigured = () =>
  getFirebaseAdminDiagnostics().configured;
