import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { upload } from "../middlewares/upload.middleware";
import {
  requireAdmin,
  requireBranchOperator,
  requireOrderManager,
} from "../middlewares/permissions.middleware";
import * as bookingController from "../controllers/booking.controller";

const router = Router();

//////////////////////////////////////////////////////
// CUSTOMER BOOKING FLOW
//////////////////////////////////////////////////////

router.post(
  "/preview",
  requireAuth,
  bookingController.previewBooking
);

router.post(
  "/",
  requireAuth,
  bookingController.createBooking
);

router.post(
  "/uploads",
  requireAuth,
  upload.array("files", 10),
  bookingController.uploadBookingUploads
);

router.get(
  "/my",
  requireAuth,
  bookingController.getMyBookings
);

router.get(
  "/:id",
  requireAuth,
  bookingController.getBookingById
);

router.post(
  "/:id/cancel",
  requireAuth,
  bookingController.cancelBooking
);

router.get(
  "/:id/timeline",
  requireAuth,
  bookingController.getBookingTimeline
);

//////////////////////////////////////////////////////
// ADMIN DASHBOARD
//////////////////////////////////////////////////////

router.get(
  "/dashboard/admin",
  requireAuth,
  requireAdmin,
  bookingController.listBookingsAdmin
);

//////////////////////////////////////////////////////
// BRANCH ADMIN DASHBOARD
//////////////////////////////////////////////////////

router.get(
  "/dashboard/branch",
  requireAuth,
  requireBranchOperator,
  bookingController.listBookingsForBranchAdmin
);

//////////////////////////////////////////////////////
// STATUS & PAYMENT UPDATES
//////////////////////////////////////////////////////

router.patch(
  "/:id/status",
  requireAuth,
  requireOrderManager,
  bookingController.updateBookingStatus
);

router.patch(
  "/:id/payment",
  requireAuth,
  requireOrderManager,
  bookingController.updatePaymentStatus
);

router.delete(
  "/:id",
  requireAuth,
  requireOrderManager,
  bookingController.archiveBooking
);

export default router;
