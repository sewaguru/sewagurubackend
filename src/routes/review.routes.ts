import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import * as reviewController from "../controllers/review.controller";

const router = Router();

router.get(
  "/services/:slug",
  reviewController.getServiceReviewsBySlug
);

router.get(
  "/bookings/:bookingId",
  requireAuth,
  reviewController.getMyBookingReviewContext
);

router.post(
  "/booking-items/:bookingItemId",
  requireAuth,
  reviewController.createReviewForBookingItem
);

export default router;
