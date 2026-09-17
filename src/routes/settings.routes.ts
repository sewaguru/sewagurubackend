import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";
import * as platformSettingsController from "../controllers/platformSettings.controller";

const router = Router();

router.get(
  "/payment",
  platformSettingsController.getPublicPaymentSettings
);

router.get(
  "/payment/admin",
  requireAuth,
  requireSuperAdmin,
  platformSettingsController.getAdminPaymentSettings
);

router.put(
  "/payment/admin",
  requireAuth,
  requireSuperAdmin,
  platformSettingsController.updateAdminPaymentSettings
);

router.get(
  "/commission/admin",
  requireAuth,
  requireSuperAdmin,
  platformSettingsController.getAdminCommissionSettings
);

router.put(
  "/commission/admin",
  requireAuth,
  requireSuperAdmin,
  platformSettingsController.updateAdminCommissionSettings
);

router.get(
  "/email/admin",
  requireAuth,
  requireSuperAdmin,
  platformSettingsController.getAdminEmailSettings
);

router.put(
  "/email/admin",
  requireAuth,
  requireSuperAdmin,
  platformSettingsController.updateAdminEmailSettings
);

export default router;
