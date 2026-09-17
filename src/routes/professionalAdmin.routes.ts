import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireAdmin } from "../middlewares/permissions.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import * as professionalAdminController from "../controllers/professionalAdmin.controller";

const router = Router();

// Distinct top-level namespace (not nested under /professional, which is
// gated for role PROFESSIONAL only) so an admin session can never collide
// with the professional self-service router.
router.use(requireAuth, requireAdmin, rateLimiters.authenticated);

//////////////////////////////////////////////////////
// LIST / DETAIL
//////////////////////////////////////////////////////

router.get("/", professionalAdminController.listProfessionals);
router.get("/:id", professionalAdminController.getProfessionalDetail);
router.patch("/:id", professionalAdminController.updateProfessionalByAdmin);

//////////////////////////////////////////////////////
// SERVICE AREA
//////////////////////////////////////////////////////

router.patch(
  "/:id/service-area",
  professionalAdminController.updateServiceAreaByAdmin
);

//////////////////////////////////////////////////////
// SERVICES
//////////////////////////////////////////////////////

router.get(
  "/:id/services",
  professionalAdminController.listProfessionalServicesByAdmin
);
router.post(
  "/:id/services",
  professionalAdminController.addProfessionalServiceByAdmin
);
router.delete(
  "/:id/services/:serviceNodeId",
  professionalAdminController.removeProfessionalServiceByAdmin
);

//////////////////////////////////////////////////////
// DOCUMENTS
//////////////////////////////////////////////////////

router.get(
  "/:id/documents",
  professionalAdminController.listProfessionalDocumentsByAdmin
);
router.patch(
  "/:id/documents/:documentId",
  professionalAdminController.reviewProfessionalDocument
);

//////////////////////////////////////////////////////
// ONBOARDING STATUS
//////////////////////////////////////////////////////

router.get(
  "/:id/onboarding-status",
  professionalAdminController.getOnboardingStatusByAdmin
);

//////////////////////////////////////////////////////
// LIFECYCLE ACTIONS
//////////////////////////////////////////////////////

router.post("/:id/review", professionalAdminController.reviewProfessional);
router.post("/:id/approve", professionalAdminController.approveProfessional);
router.post("/:id/reject", professionalAdminController.rejectProfessional);
router.post("/:id/suspend", professionalAdminController.suspendProfessional);
router.post("/:id/block", professionalAdminController.blockProfessional);
router.post(
  "/:id/reactivate",
  professionalAdminController.reactivateProfessional
);

//////////////////////////////////////////////////////
// PAYOUT PROCESSING
//////////////////////////////////////////////////////

router.patch(
  "/payouts/:payoutId",
  professionalAdminController.updatePayoutStatus
);

//////////////////////////////////////////////////////
// STATISTICS & REVIEWS
//////////////////////////////////////////////////////

router.get(
  "/:id/statistics",
  professionalAdminController.getProfessionalStatisticsByAdmin
);
router.get(
  "/:id/reviews",
  professionalAdminController.listProfessionalReviewsByAdmin
);

export default router;
