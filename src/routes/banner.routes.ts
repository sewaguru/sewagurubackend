import { Router } from "express";
import {
  adminListBanners,
  createBanner,
  deleteBanner,
  listPublicBanners,
  reorderBanners,
  updateBanner,
} from "../controllers/banner.controller";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";

const router = Router();

//////////////////////////////////////////////////////
// PUBLIC BANNERS (STOREFRONT HOMEPAGE)
//////////////////////////////////////////////////////

router.get("/public", listPublicBanners);

//////////////////////////////////////////////////////
// ADMIN (DASHBOARD)
//////////////////////////////////////////////////////

router.get("/admin", requireAuth, requireSuperAdmin, adminListBanners);
router.post("/admin", requireAuth, requireSuperAdmin, createBanner);
router.patch(
  "/admin/reorder",
  requireAuth,
  requireSuperAdmin,
  reorderBanners
);
router.put("/admin/:id", requireAuth, requireSuperAdmin, updateBanner);
router.delete("/admin/:id", requireAuth, requireSuperAdmin, deleteBanner);

export default router;
