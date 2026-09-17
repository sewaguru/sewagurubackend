import { Router } from "express";
import * as serviceController from "../controllers/service.controller";

import { requireAuth } from "../middlewares/auth.middleware";
import {
  requireBranchOperator,
  requireSuperAdmin,
} from "../middlewares/permissions.middleware";

const router = Router();

//////////////////////////////////////////////////////
// PUBLIC SERVICE TREE
//////////////////////////////////////////////////////

// ✅ STATIC FIRST
router.get("/root",
  serviceController.getRootServices
);

router.get("/search",
  serviceController.searchServices
);

router.post(
  "/calculate-price",
  serviceController.calculatePrice
);

router.get("/slug/:slug",
  serviceController.getServiceBySlug
);

router.get("/id/:id",
  serviceController.getPublicServiceById
);

// ✅ DYNAMIC LAST
router.get("/:id/children",
  serviceController.getServiceChildren
);

//////////////////////////////////////////////////////
// ADMIN SERVICE TREE
//////////////////////////////////////////////////////

router.get(
  "/admin",
  requireAuth,
  requireSuperAdmin,
  serviceController.adminListServices
);

router.get(
  "/admin/tree",
  requireAuth,
  requireSuperAdmin,
  serviceController.adminGetTree
);

router.post(
  "/admin",
  requireAuth,
  requireSuperAdmin,
  serviceController.createServiceNode
);

router.patch(
  "/admin/reorder",
  requireAuth,
  requireSuperAdmin,
  serviceController.reorderServiceNodes
);

router.get(
  "/admin/:id",
  requireAuth,
  requireSuperAdmin,
  serviceController.adminGetServiceById
);

router.put(
  "/admin/:id",
  requireAuth,
  requireSuperAdmin,
  serviceController.updateServiceNode
);

router.delete(
  "/admin/:id",
  requireAuth,
  requireSuperAdmin,
  serviceController.deleteServiceNode
);

//////////////////////////////////////////////////////
// BRANCH SERVICES
//////////////////////////////////////////////////////

router.get(
  "/branch-services/availability",
  requireAuth,
  requireBranchOperator,
  serviceController.listBranchServiceAvailability
);

router.post(
  "/branch-services",
  requireAuth,
  requireBranchOperator,
  serviceController.enableBranchService
);

router.post(
  "/branch-services/node-availability",
  requireAuth,
  requireBranchOperator,
  serviceController.setBranchServiceNodeAvailability
);

router.patch(
  "/branch-services/:id",
  requireAuth,
  requireBranchOperator,
  serviceController.updateBranchService
);

router.delete(
  "/branch-services/:id",
  requireAuth,
  requireBranchOperator,
  serviceController.disableBranchService
);

export default router;
