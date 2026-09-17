import { Router } from "express";

import {
  createBranch,
  getBranches,
  getBranchById,
  updateBranch,
  toggleBranchStatus,
  deleteBranch,
  assignBranchAdmin,
  removeBranchAdmin,
  getPublicBranches,
} from "../controllers/branch.controller";
import {
  getBranchBookingSettings,
  getPublicBranchBookingSettings,
  updateBranchBookingSettings,
} from "../controllers/branchBookingSettings.controller";

import { requireAuth } from "../middlewares/auth.middleware";
import {
  requireBranchOperator,
  requireOrderManager,
  requireSuperAdmin,
} from "../middlewares/permissions.middleware";

const router = Router();

//////////////////////////////////////////////////////
// CREATE
//////////////////////////////////////////////////////

router.post(
  "/",
  requireAuth,
  requireSuperAdmin,
  createBranch
);

//////////////////////////////////////////////////////
// VIEW LIST
//////////////////////////////////////////////////////

// Admin dashboard list (includes admins)
router.get(
  "/",
  requireAuth,
  requireOrderManager,
  getBranches
);

// Public list for frontend website
router.get(
  "/public/:id/booking-settings",
  getPublicBranchBookingSettings
);

router.get(
  "/public",
  getPublicBranches
);

//////////////////////////////////////////////////////
// BOOKING SETTINGS
//////////////////////////////////////////////////////

router.get(
  "/:id/booking-settings",
  requireAuth,
  requireBranchOperator,
  getBranchBookingSettings
);

router.put(
  "/:id/booking-settings",
  requireAuth,
  requireBranchOperator,
  updateBranchBookingSettings
);

//////////////////////////////////////////////////////
// STATUS
//////////////////////////////////////////////////////

router.patch(
  "/:id/status",
  requireAuth,
  requireSuperAdmin,
  toggleBranchStatus
);

//////////////////////////////////////////////////////
// UPDATE
//////////////////////////////////////////////////////

router.put(
  "/:id",
  requireAuth,
  requireBranchOperator,
  updateBranch
);

//////////////////////////////////////////////////////
// DELETE (SOFT)
//////////////////////////////////////////////////////

router.delete(
  "/:id",
  requireAuth,
  requireSuperAdmin,
  deleteBranch
);

//////////////////////////////////////////////////////
// ADMIN MANAGEMENT
//////////////////////////////////////////////////////

router.post(
  "/:id/admins",
  requireAuth,
  requireSuperAdmin,
  assignBranchAdmin
);

router.delete(
  "/:id/admins/:userId",
  requireAuth,
  requireSuperAdmin,
  removeBranchAdmin
);

//////////////////////////////////////////////////////
// ⚠️ ALWAYS LAST
//////////////////////////////////////////////////////

router.get(
  "/:id",
  requireAuth,
  requireBranchOperator,
  getBranchById
);

export default router;
