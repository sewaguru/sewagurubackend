import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  requireSuperAdmin,
} from "../middlewares/permissions.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";

import {
  getProfile,
  updateProfile,
  getDashboardProfile,
  getAllAdmins,
  getAllUsers,
  updateUserRole,
  toggleUserBlock,
  archiveUser,
  deleteOwnAccount,
  sendDeleteAccountOtp,
  confirmDeleteOwnAccount,
  getUserById,
  getUserPaymentOrders,
  sendEmailVerification,
  verifyEmail,
} from "../controllers/user.controller";

import {
  addAddress,
  deleteAddress,
  updateAddress,
  getAddresses,
  setPrimaryAddress,
  getAddressById,
} from "../controllers/address.controller";

const router = Router();

//////////////////////////////////////////////////////
// APP USER PROFILE
//////////////////////////////////////////////////////

router.get("/profile", requireAuth, getProfile);
router.put("/profile", requireAuth, updateProfile);
router.delete(
  "/profile",
  rateLimiters.authenticated,
  requireAuth,
  deleteOwnAccount
);
router.post(
  "/profile/delete-otp",
  rateLimiters.otpSend,
  requireAuth,
  sendDeleteAccountOtp
);
router.post(
  "/profile/delete-confirm",
  rateLimiters.otpVerify,
  requireAuth,
  confirmDeleteOwnAccount
);

//////////////////////////////////////////////////////
// EMAIL VERIFICATION
//////////////////////////////////////////////////////

router.post(
  "/send-email-verification",
  requireAuth,
  sendEmailVerification
);

router.get(
  "/verify-email",
  verifyEmail
);

//////////////////////////////////////////////////////
// ADMIN USERS
//////////////////////////////////////////////////////

router.get(
  "/admins",
  requireAuth,
  requireSuperAdmin,
  getAllAdmins
);

//////////////////////////////////////////////////////
// DASHBOARD PROFILE
//////////////////////////////////////////////////////

router.get(
  "/dashboard/me",
  requireAuth,
  getDashboardProfile
);

//////////////////////////////////////////////////////
// ADDRESS
//////////////////////////////////////////////////////

router.get("/addresses", requireAuth, getAddresses);
router.post("/addresses", requireAuth, addAddress);
router.get("/addresses/:id", requireAuth, getAddressById);
router.put("/addresses/:id", requireAuth, updateAddress);
router.delete("/addresses/:id", requireAuth, deleteAddress);
router.post(
  "/addresses/:id/primary",
  requireAuth,
  setPrimaryAddress
);
//////////////////////////////////////////////////////
// DASHBOARD USER MANAGEMENT
//////////////////////////////////////////////////////

router.get(
  "/dashboard/users",
  requireAuth,
  requireSuperAdmin,
  getAllUsers
);

router.get(
  "/dashboard/users/:id",
  requireAuth,
  requireSuperAdmin,
  getUserById
);

router.get(
  "/dashboard/users/:id/payment-orders",
  requireAuth,
  requireSuperAdmin,
  getUserPaymentOrders
);

router.patch(
  "/dashboard/users/:id/role",
  requireAuth,
  requireSuperAdmin,
  updateUserRole
);

router.patch(
  "/dashboard/users/:id/block",
  requireAuth,
  requireSuperAdmin,
  toggleUserBlock
);

router.delete(
  "/dashboard/users/:id",
  requireAuth,
  requireSuperAdmin,
  archiveUser
);
export default router;
