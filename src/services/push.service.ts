import type { MulticastMessage } from "firebase-admin/messaging";
import {
  getFirebaseAdminDiagnostics,
  getFirebaseMessaging,
  type FirebaseCredentialSource,
} from "../lib/firebase-admin";
import { prisma } from "../lib/prisma";
import {
  isInvalidFcmRegistrationTokenError,
  maskDeviceToken,
} from "../utils/fcm-token.util";

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
};

export type PushDispatchStatus =
  | "DELIVERED"
  | "FAILED"
  | "SKIPPED";

export type PushUserDispatchResult = {
  userId: string;
  status: PushDispatchStatus;
  tokenCount: number;
  deliveredDeviceCount: number;
  failedDeviceCount: number;
  errorMessage?: string;
};

export type PushTokenDispatchStatus =
  | "DELIVERED"
  | "FAILED";

export type PushTokenDispatchResult = {
  maskedToken: string;
  status: PushTokenDispatchStatus;
  messageId?: string;
  errorCode?: string;
  errorMessage?: string;
  removedFromStore: boolean;
};

export type PushTokenDispatchSummary = {
  providerConfigured: boolean;
  firebaseProjectId: string | null;
  credentialSource: FirebaseCredentialSource;
  providerError: string | null;
  requestedTokenCount: number;
  deliveredDeviceCount: number;
  failedDeviceCount: number;
  invalidTokenCount: number;
  staleTokensRemovedCount: number;
  tokenResults: PushTokenDispatchResult[];
  errorMessage?: string;
};

const logPush = (
  message: string,
  meta?: Record<string, unknown>,
) => {
  if (meta) {
    console.info("[Push]", message, meta);
    return;
  }

  console.info("[Push]", message);
};

const normalizeTokens = (tokens: string[]) =>
  [
    ...new Set(
      tokens
        .map((token) => token.trim())
        .filter((token) => token),
    ),
  ];

const defaultAndroidChannelId = "default";

const getDeviceTokensForUser = async (
  userId: string,
) =>
  prisma.deviceToken.findMany({
    where: {
      userId,
      user: {
        isActive: true,
        isBlocked: false,
        deletedAt: null,
        deletionStatus: {
          not: "REQUESTED",
        },
      },
    },
    select: {
      token: true,
      platform: true,
      deviceId: true,
      appVersion: true,
      updatedAt: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

const buildMessage = (
  tokens: string[],
  payload: PushPayload,
): MulticastMessage => ({
  tokens,
  notification: {
    title: payload.title,
    body: payload.body,
    ...(payload.imageUrl
      ? {
          imageUrl: payload.imageUrl,
        }
      : {}),
  },
  data: {
    ...(payload.data ?? {}),
    title: payload.title,
    body: payload.body,
    ...(payload.imageUrl
      ? {
          imageUrl: payload.imageUrl,
        }
      : {}),
  },
  android: {
    priority: "high",
    notification: {
      title: payload.title,
      body: payload.body,
      channelId: defaultAndroidChannelId,
      clickAction: "FLUTTER_NOTIFICATION_CLICK",
      sound: "default",
    },
  },
  apns: {
    payload: {
      aps: {
        sound: "default",
        badge: 1,
      },
    },
  },
});

export const isPushProviderConfigured = () =>
  getFirebaseAdminDiagnostics({
    initialize: true,
  }).ready;

export const getPushProviderDiagnostics = () =>
  getFirebaseAdminDiagnostics({
    initialize: true,
  });

export const sendPushToTokensDetailed = async (
  tokens: string[],
  payload: PushPayload,
): Promise<PushTokenDispatchSummary> => {
  const normalizedTokens = normalizeTokens(tokens);
  const diagnostics = getPushProviderDiagnostics();

  if (!normalizedTokens.length) {
    return {
      providerConfigured: diagnostics.ready,
      firebaseProjectId: diagnostics.projectId,
      credentialSource:
        diagnostics.credentialSource,
      providerError: diagnostics.errorMessage,
      requestedTokenCount: 0,
      deliveredDeviceCount: 0,
      failedDeviceCount: 0,
      invalidTokenCount: 0,
      staleTokensRemovedCount: 0,
      tokenResults: [],
      errorMessage:
        "No device tokens were provided.",
    };
  }

  const messaging = getFirebaseMessaging();
  const liveDiagnostics = getPushProviderDiagnostics();
  if (!messaging) {
    logPush("Push provider unavailable for token send.", {
      tokenCount: normalizedTokens.length,
      providerError:
        liveDiagnostics.errorMessage,
      credentialSource:
        liveDiagnostics.credentialSource,
      projectId: liveDiagnostics.projectId,
    });

    return {
      providerConfigured: liveDiagnostics.ready,
      firebaseProjectId:
        liveDiagnostics.projectId,
      credentialSource:
        liveDiagnostics.credentialSource,
      providerError:
        liveDiagnostics.errorMessage,
      requestedTokenCount:
        normalizedTokens.length,
      deliveredDeviceCount: 0,
      failedDeviceCount:
        normalizedTokens.length,
      invalidTokenCount: 0,
      staleTokensRemovedCount: 0,
      tokenResults: normalizedTokens.map(
        (token) => ({
          maskedToken: maskDeviceToken(token),
          status: "FAILED",
          errorMessage:
            liveDiagnostics.errorMessage ??
            "Push delivery is not connected on this backend yet.",
          removedFromStore: false,
        }),
      ),
      errorMessage:
        liveDiagnostics.errorMessage ??
        "Push delivery is not connected on this backend yet.",
    };
  }

  try {
    logPush("Dispatching detailed push notification.", {
      tokenCount: normalizedTokens.length,
      title: payload.title,
      androidChannelId: defaultAndroidChannelId,
      hasData: Boolean(
        payload.data &&
          Object.keys(payload.data).length,
      ),
      campaignId:
        payload.data?.campaignId ?? null,
    });

    const response =
      await messaging.sendEachForMulticast(
        buildMessage(normalizedTokens, payload),
      );

    const stale: string[] = [];
    let invalidTokenCount = 0;
    let errorMessage: string | undefined;

    const tokenResults = response.responses.map(
      (result, index) => {
        const token =
          normalizedTokens[index] ?? "";

        if (result.success) {
          logPush("Firebase accepted push for token.", {
            maskedToken: maskDeviceToken(token),
            messageId: result.messageId ?? null,
          });
          return {
            maskedToken: maskDeviceToken(token),
            status: "DELIVERED" as const,
            removedFromStore: false,
            ...(result.messageId
              ? {
                  messageId: result.messageId,
                }
              : {}),
          };
        }

        errorMessage ??=
          result.error?.message ??
          "Push dispatch failed.";

        const code = result.error?.code ?? "";
        const errorMessageForToken =
          result.error?.message ??
          "Push dispatch failed.";
        const removedFromStore =
          isInvalidFcmRegistrationTokenError(
            code,
            errorMessageForToken,
          );

        if (removedFromStore && token) {
          stale.push(token);
          invalidTokenCount += 1;
        }

        logPush("Firebase rejected push for token.", {
          maskedToken: maskDeviceToken(token),
          errorCode: code || null,
          errorMessage: errorMessageForToken,
          removedFromStore,
        });

        return {
          maskedToken: maskDeviceToken(token),
          status: "FAILED" as const,
          errorMessage: errorMessageForToken,
          removedFromStore,
          ...(code
            ? {
                errorCode: code,
              }
            : {}),
        };
      },
    );

    const staleTokensRemovedCount =
      stale.length;
    if (staleTokensRemovedCount) {
      await prisma.deviceToken
        .deleteMany({
          where: {
            token: {
              in: stale,
            },
          },
        })
        .catch((error) => {
          console.error(
            "[Push] Failed to delete stale device tokens.",
            error,
          );
        });

      logPush("Removed stale device tokens after Firebase rejection.", {
        staleTokensRemovedCount,
        tokens: stale.map((token) =>
          maskDeviceToken(token),
        ),
      });
    }

    const deliveredMessageIds =
      tokenResults.flatMap((result) =>
        result.status === "DELIVERED" &&
        "messageId" in result &&
        result.messageId
          ? [result.messageId]
          : [],
      );

    logPush("Detailed push dispatch completed.", {
      tokenCount: normalizedTokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokenCount,
      staleTokensRemovedCount,
      messageIds: deliveredMessageIds,
      firstError: errorMessage ?? null,
    });

    return {
      providerConfigured: liveDiagnostics.ready,
      firebaseProjectId:
        liveDiagnostics.projectId,
      credentialSource:
        liveDiagnostics.credentialSource,
      providerError:
        liveDiagnostics.errorMessage,
      requestedTokenCount:
        normalizedTokens.length,
      deliveredDeviceCount:
        response.successCount,
      failedDeviceCount:
        response.failureCount,
      invalidTokenCount,
      staleTokensRemovedCount,
      tokenResults,
      ...(errorMessage
        ? {
            errorMessage,
          }
        : {}),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Push dispatch failed.";

    console.error(
      "[Push] Detailed dispatch error:",
      error,
    );

    return {
      providerConfigured: liveDiagnostics.ready,
      firebaseProjectId:
        liveDiagnostics.projectId,
      credentialSource:
        liveDiagnostics.credentialSource,
      providerError:
        liveDiagnostics.errorMessage ??
        message,
      requestedTokenCount:
        normalizedTokens.length,
      deliveredDeviceCount: 0,
      failedDeviceCount:
        normalizedTokens.length,
      invalidTokenCount: 0,
      staleTokensRemovedCount: 0,
      tokenResults: normalizedTokens.map(
        (token) => ({
          maskedToken: maskDeviceToken(token),
          status: "FAILED",
          errorMessage: message,
          removedFromStore: false,
        }),
      ),
      errorMessage: message,
    };
  }
};

export const sendPushToUser = async (
  userId: string,
  payload: PushPayload,
): Promise<void> => {
  const rows =
    await getDeviceTokensForUser(userId);

  if (!rows.length) {
    logPush(
      "No device tokens found for user push send.",
      {
        userId,
      },
    );
    return;
  }

  logPush("Resolved device tokens for user push send.", {
    userId,
    tokenCount: rows.length,
    platforms: rows.map((row) => row.platform),
  });

  await sendPushToTokensDetailed(
    rows.map((row) => row.token),
    payload,
  );
};

export const sendPushToUserDetailed = async (
  userId: string,
  payload: PushPayload,
): Promise<PushUserDispatchResult> => {
  const rows =
    await getDeviceTokensForUser(userId);

  if (!rows.length) {
    logPush(
      "No device tokens found for detailed push send.",
      {
        userId,
      },
    );
    return {
      userId,
      status: "SKIPPED",
      tokenCount: 0,
      deliveredDeviceCount: 0,
      failedDeviceCount: 0,
      errorMessage:
        "No active device tokens were found for this user.",
    };
  }

  logPush("Resolved device tokens for detailed push send.", {
    userId,
    tokenCount: rows.length,
    platforms: rows.map((row) => row.platform),
  });

  const result =
    await sendPushToTokensDetailed(
      rows.map((row) => row.token),
      payload,
    );

  return {
    userId,
    status:
      !result.providerConfigured
        ? "SKIPPED"
        : result.deliveredDeviceCount > 0
          ? "DELIVERED"
          : "FAILED",
    tokenCount: rows.length,
    deliveredDeviceCount:
      result.deliveredDeviceCount,
    failedDeviceCount:
      result.failedDeviceCount,
    ...(result.errorMessage
      ? {
          errorMessage:
            result.errorMessage,
        }
      : {}),
  };
};

export const sendPushToUsers = async (
  userIds: string[],
  payload: PushPayload,
): Promise<void> => {
  const unique = [...new Set(userIds)];
  if (!unique.length) {
    return;
  }

  const rows =
    await prisma.deviceToken.findMany({
      where: {
        userId: {
          in: unique,
        },
        user: {
          isActive: true,
          isBlocked: false,
          deletedAt: null,
          deletionStatus: {
            not: "REQUESTED",
          },
        },
      },
      select: {
        token: true,
      },
    });

  if (!rows.length) {
    logPush(
      "No device tokens found for multi-user push send.",
      {
        userCount: unique.length,
      },
    );
    return;
  }

  logPush("Resolved device tokens for multi-user push send.", {
    requestedUserCount: unique.length,
    resolvedTokenCount: rows.length,
  });

  await sendPushToTokensDetailed(
    rows.map((row) => row.token),
    payload,
  );
};
