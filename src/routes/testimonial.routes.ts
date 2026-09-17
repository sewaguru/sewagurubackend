import { Router } from "express";
import {
  adminListTestimonials,
  createTestimonial,
  deleteTestimonial,
  listPublicTestimonials,
  reorderTestimonials,
  updateTestimonial,
} from "../controllers/testimonial.controller";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";

const router = Router();

//////////////////////////////////////////////////////
// PUBLIC TESTIMONIALS (STOREFRONT HOMEPAGE)
//////////////////////////////////////////////////////

router.get("/public", listPublicTestimonials);

//////////////////////////////////////////////////////
// ADMIN (DASHBOARD)
//////////////////////////////////////////////////////

router.get("/admin", requireAuth, requireSuperAdmin, adminListTestimonials);
router.post("/admin", requireAuth, requireSuperAdmin, createTestimonial);
router.patch(
  "/admin/reorder",
  requireAuth,
  requireSuperAdmin,
  reorderTestimonials
);
router.put("/admin/:id", requireAuth, requireSuperAdmin, updateTestimonial);
router.delete(
  "/admin/:id",
  requireAuth,
  requireSuperAdmin,
  deleteTestimonial
);

export default router;
