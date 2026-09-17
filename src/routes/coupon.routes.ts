import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  requireBranchOperator,
  requireSuperAdmin,
} from "../middlewares/permissions.middleware";
import * as couponController from "../controllers/coupon.controller";

const router = Router();

//////////////////////////////////////////////////////
// ADMIN COUPON MANAGEMENT
//////////////////////////////////////////////////////

router.get(
  "/",
  requireAuth,
  requireSuperAdmin,
  couponController.listCoupons
);

router.post(
  "/",
  requireAuth,
  requireSuperAdmin,
  couponController.createCoupon
);

router.post(
  "/validate",
  requireAuth,
  couponController.validateCoupon
);

//////////////////////////////////////////////////////
// BRANCH ADMIN COUPONS
//////////////////////////////////////////////////////

router.get(
  "/branch",
  requireAuth,
  requireBranchOperator,
  couponController.listBranchCoupons
);

router.post(
  "/branch",
  requireAuth,
  requireBranchOperator,
  couponController.createBranchCoupon
);

router.patch(
  "/branch/:id",
  requireAuth,
  requireBranchOperator,
  couponController.updateBranchCoupon
);

//////////////////////////////////////////////////////
// ADMIN: GET / UPDATE COUPON BY ID
// Keep parameterized routes last to avoid shadowing
//////////////////////////////////////////////////////

router.get(
  "/:id",
  requireAuth,
  requireSuperAdmin,
  couponController.getCouponById
);

router.patch(
  "/:id",
  requireAuth,
  requireSuperAdmin,
  couponController.updateCoupon
);

export default router;
