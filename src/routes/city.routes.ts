import { Router } from "express";
import {
  createCity,
  getCities,
  toggleCityStatus,
  updateCity,
} from "../controllers/city.controller";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";

const router = Router();

//////////////////////////////////////////////////////
// PUBLIC CITIES (FRONTEND WEBSITE)
//////////////////////////////////////////////////////

router.get("/public", getCities);

//////////////////////////////////////////////////////
// AUTHENTICATED (DASHBOARD / APP)
//////////////////////////////////////////////////////

router.get("/", requireAuth, getCities);

router.post(
  "/",
  requireAuth,
  requireSuperAdmin,
  createCity
);

router.patch(
  "/:id",
  requireAuth,
  requireSuperAdmin,
  updateCity
);

router.patch(
  "/:id/status",
  requireAuth,
  requireSuperAdmin,
  toggleCityStatus
);

export default router;
