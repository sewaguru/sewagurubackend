import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireProfessional } from "../middlewares/permissions.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import { uploadDocument } from "../middlewares/upload.middleware";
import * as professionalController from "../controllers/professional.controller";
import * as professionalEarningsController from "../controllers/professionalEarnings.controller";

const router = Router();

// Every route below is self-service only: it always resolves the acting
// professional's own ProfessionalProfile via req.user.id. None of these
// accept another professional's id, so cross-professional access is not
// possible through this router.
//
// Phase 10 hardening: a general rate limit is applied to every route on
// this router (most of Phases 2-9 had none at all beyond the two
// deliberately stricter tiers below). Routes with their own tighter
// limiter (document upload, location ping) still get that limiter too —
// both apply, the stricter one simply binds first for that specific route.
router.use(requireAuth, requireProfessional, rateLimiters.authenticated);

//////////////////////////////////////////////////////
// PROFILE
//////////////////////////////////////////////////////

router.get("/profile", professionalController.getProfessionalProfile);
router.post("/profile", professionalController.createProfessionalProfile);
router.patch("/profile", professionalController.updateProfessionalProfile);

//////////////////////////////////////////////////////
// SERVICES (reference the existing service catalogue only)
//////////////////////////////////////////////////////

router.get(
  "/my-services",
  professionalController.getMyProfessionalServices
);
router.post(
  "/my-services",
  professionalController.addProfessionalService
);
router.delete(
  "/my-services/:serviceNodeId",
  professionalController.removeProfessionalService
);

//////////////////////////////////////////////////////
// SERVICE AREA
//////////////////////////////////////////////////////

router.patch(
  "/service-area",
  professionalController.updateServiceArea
);

//////////////////////////////////////////////////////
// DOCUMENTS
//////////////////////////////////////////////////////

router.get(
  "/documents",
  professionalController.listMyProfessionalDocuments
);
router.post(
  "/documents",
  rateLimiters.mediaUpload,
  uploadDocument.single("file"),
  professionalController.uploadProfessionalDocument
);
router.delete(
  "/documents/:id",
  professionalController.deleteMyProfessionalDocument
);

//////////////////////////////////////////////////////
// ONBOARDING
//////////////////////////////////////////////////////

router.get(
  "/onboarding-status",
  professionalController.getOnboardingStatus
);

//////////////////////////////////////////////////////
// AVAILABILITY (ONLINE / OFFLINE / BUSY)
//////////////////////////////////////////////////////

router.get(
  "/availability",
  professionalController.getAvailabilityStatus
);
router.post(
  "/availability/online",
  professionalController.goOnline
);
router.post(
  "/availability/offline",
  professionalController.goOffline
);
router.patch(
  "/availability",
  professionalController.updateAvailability
);

//////////////////////////////////////////////////////
// LOCATION (LIVE PING — throttled, distinct from /service-area)
//////////////////////////////////////////////////////

router.get(
  "/location",
  professionalController.getMyLocation
);
router.patch(
  "/location",
  rateLimiters.locationUpdate,
  professionalController.updateMyLocation
);

//////////////////////////////////////////////////////
// JOB OFFERS
//////////////////////////////////////////////////////

router.get(
  "/job-offers",
  professionalController.listMyJobOffers
);
router.post(
  "/job-offers/:id/accept",
  professionalController.acceptMyJobOffer
);
router.post(
  "/job-offers/:id/reject",
  professionalController.rejectMyJobOffer
);

//////////////////////////////////////////////////////
// ASSIGNED JOBS (LIFECYCLE)
//////////////////////////////////////////////////////

router.get("/jobs", professionalController.listMyJobs);
router.get("/jobs/:id", professionalController.getMyJobById);
router.post(
  "/jobs/:id/start-travel",
  professionalController.startJobTravel
);
router.post("/jobs/:id/arrived", professionalController.markJobArrived);
router.post(
  "/jobs/:id/start-work",
  professionalController.startJobWork
);
router.post("/jobs/:id/complete", professionalController.completeJob);
router.post("/jobs/:id/cancel", professionalController.cancelMyJob);

//////////////////////////////////////////////////////
// EARNINGS
//////////////////////////////////////////////////////

router.get(
  "/earnings/summary",
  professionalEarningsController.getEarningsSummary
);
router.get("/balance", professionalEarningsController.getBalance);
router.get("/earnings", professionalEarningsController.listMyEarnings);
router.get(
  "/earnings/:id",
  professionalEarningsController.getMyEarningById
);

//////////////////////////////////////////////////////
// BANK ACCOUNTS
//////////////////////////////////////////////////////

router.get(
  "/bank-accounts",
  professionalEarningsController.listMyBankAccounts
);
router.post(
  "/bank-accounts",
  professionalEarningsController.addMyBankAccount
);
router.patch(
  "/bank-accounts/:id/primary",
  professionalEarningsController.setPrimaryBankAccount
);
router.delete(
  "/bank-accounts/:id",
  professionalEarningsController.deleteMyBankAccount
);

//////////////////////////////////////////////////////
// PAYOUTS
//////////////////////////////////////////////////////

router.get("/payouts", professionalEarningsController.listMyPayouts);
router.get(
  "/payouts/:id",
  professionalEarningsController.getMyPayoutById
);
router.post(
  "/payouts/request",
  professionalEarningsController.requestMyPayout
);

//////////////////////////////////////////////////////
// STATISTICS & REVIEWS
//////////////////////////////////////////////////////

router.get("/statistics", professionalController.getMyStatistics);
router.get("/reviews", professionalController.listMyReviews);

export default router;
