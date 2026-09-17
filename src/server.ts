import path from "path";

import app from "./app";
import { config } from "./config/config";
import { startNotificationCampaignScheduler } from "./services/notification-campaign.service";
import { startTrashCleanupJob } from "./services/trash.service";
import { startAccountDeletionJob } from "./services/account-deletion.service";
import { startDispatchSweepJob } from "./services/dispatch.service";

const runtimeSource = __filename.includes(
  `${path.sep}dist${path.sep}`
)
  ? "dist"
  : "src";

process.env.RUNTIME_SOURCE = runtimeSource;
process.env.RUNTIME_ENTRY = __filename;

const startServer = () => {
  try {
    if (
      config.NODE_ENV === "production" &&
      runtimeSource !== "dist"
    ) {
      throw new Error(
        "Production runtime must start from dist build (node dist/server.js)."
      );
    }

    let stopTrashCleanup:
      | (() => void)
      | undefined;
    let stopNotificationScheduler:
      | (() => void)
      | undefined;
    let stopAccountDeletionJob:
      | (() => void)
      | undefined;
    let stopDispatchSweep:
      | (() => void)
      | undefined;

    const server = app.listen(config.PORT, () => {
      console.log(
        `[BOOT] Server running in ${config.NODE_ENV} mode on port ${config.PORT}`
      );
      console.log(
        `[BOOT] Runtime source: ${runtimeSource} (${__filename})`
      );
      console.log(
        "[BOOT] Prisma pool configured.",
        {
          maxConnections:
            config.DATABASE_POOL_MAX,
          idleTimeoutMs:
            config.DATABASE_POOL_IDLE_TIMEOUT_MS,
          connectionTimeoutMs:
            config.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
        }
      );

      if (
        config.ENABLE_TRASH_CLEANUP_JOB
      ) {
        stopTrashCleanup =
          startTrashCleanupJob();
        console.log(
          "[BOOT] Trash cleanup job enabled."
        );
      } else {
        console.log(
          "[BOOT] Trash cleanup job disabled for this runtime."
        );
      }

      if (
        config.ENABLE_NOTIFICATION_CAMPAIGN_SCHEDULER
      ) {
        stopNotificationScheduler =
          startNotificationCampaignScheduler();
        console.log(
          "[BOOT] Notification campaign scheduler enabled.",
          {
            intervalMs:
              config.NOTIFICATION_CAMPAIGN_SCHEDULER_INTERVAL_MS,
          }
        );
      } else {
        console.log(
          "[BOOT] Notification campaign scheduler disabled for this runtime."
        );
      }

      if (config.ENABLE_ACCOUNT_DELETION_JOB) {
        stopAccountDeletionJob =
          startAccountDeletionJob();
        console.log(
          "[BOOT] Account deletion job enabled.",
          {
            intervalMs:
              config.ACCOUNT_DELETION_JOB_INTERVAL_MS,
            batchSize:
              config.ACCOUNT_DELETION_JOB_BATCH_SIZE,
          }
        );
      } else {
        console.log(
          "[BOOT] Account deletion job disabled for this runtime."
        );
      }

      if (config.ENABLE_DISPATCH_SWEEP_JOB) {
        stopDispatchSweep =
          startDispatchSweepJob();
        console.log(
          "[BOOT] Dispatch sweep job enabled.",
          {
            intervalMs:
              config.DISPATCH_SWEEP_INTERVAL_MS,
            batchSize:
              config.DISPATCH_BATCH_SIZE,
            offerTtlMinutes:
              config.DISPATCH_OFFER_TTL_MINUTES,
          }
        );
      } else {
        console.log(
          "[BOOT] Dispatch sweep job disabled for this runtime."
        );
      }
    });

    process.on("SIGTERM", () => {
      console.log("SIGTERM received. Shutting down...");
      stopTrashCleanup?.();
      stopNotificationScheduler?.();
      stopAccountDeletionJob?.();
      stopDispatchSweep?.();
      server.close(() => {
        process.exit(0);
      });
    });

    process.on("SIGINT", () => {
      console.log("SIGINT received. Shutting down...");
      stopTrashCleanup?.();
      stopNotificationScheduler?.();
      stopAccountDeletionJob?.();
      stopDispatchSweep?.();
      server.close(() => {
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("Server failed to start:", error);
    process.exit(1);
  }
};

startServer();
