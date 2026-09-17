import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  requireBranchOperator,
  requireSuperAdmin,
} from "../middlewares/permissions.middleware";
import * as offerController from "../controllers/offer.controller";

const router = Router();

//////////////////////////////////////////////////////
// PUBLIC OFFERS (CUSTOMER APP)
//////////////////////////////////////////////////////

router.get(
  "/public",
  offerController.listPublicOffers
);

//////////////////////////////////////////////////////
// ADMIN OFFERS MANAGEMENT
//////////////////////////////////////////////////////

router.get(
  "/",
  requireAuth,
  requireSuperAdmin,
  offerController.listOffers
);

router.post(
  "/",
  requireAuth,
  requireSuperAdmin,
  offerController.createOffer
);

//////////////////////////////////////////////////////
// BRANCH ADMIN OFFERS
//////////////////////////////////////////////////////

router.get(
  "/branch",
  requireAuth,
  requireBranchOperator,
  offerController.listBranchOffers
);

router.post(
  "/branch",
  requireAuth,
  requireBranchOperator,
  offerController.createBranchOffer
);

router.patch(
  "/branch/:id",
  requireAuth,
  requireBranchOperator,
  offerController.updateBranchOffer
);

//////////////////////////////////////////////////////
// ADMIN: GET / UPDATE OFFER BY ID
// Keep parameterized routes last to avoid shadowing
//////////////////////////////////////////////////////

router.get(
  "/:id",
  requireAuth,
  requireSuperAdmin,
  offerController.getOfferById
);

router.patch(
  "/:id",
  requireAuth,
  requireSuperAdmin,
  offerController.updateOffer
);

export default router;
