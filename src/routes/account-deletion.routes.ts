import { Router } from "express";
import {
  cancelOwnAccountDeletion,
  getAdminAccountDeletionRequests,
  getAdminAccountDeletionStats,
  getOwnAccountDeletionStatus,
  requestOwnAccountDeletion,
  runAccountDeletionJobNow,
} from "../controllers/account-deletion.controller";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";

const router = Router();

router.post(
  "/delete-request",
  rateLimiters.authenticated,
  requireAuth,
  requestOwnAccountDeletion
);

router.post(
  "/delete-cancel",
  rateLimiters.authenticated,
  requireAuth,
  cancelOwnAccountDeletion
);

router.get(
  "/delete-status",
  rateLimiters.authenticated,
  requireAuth,
  getOwnAccountDeletionStatus
);

router.get(
  "/admin/delete-requests",
  requireAuth,
  requireSuperAdmin,
  getAdminAccountDeletionRequests
);

router.get(
  "/admin/delete-stats",
  requireAuth,
  requireSuperAdmin,
  getAdminAccountDeletionStats
);

router.post(
  "/admin/delete-job/run",
  requireAuth,
  requireSuperAdmin,
  runAccountDeletionJobNow
);

export default router;
