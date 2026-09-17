import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import * as paymentController from "../controllers/payment.controller";

const router = Router();

router.post(
  "/create-order",
  rateLimiters.authenticated,
  requireAuth,
  paymentController.createPaymentOrder
);

router.get(
  "/order-status/:bookingId",
  rateLimiters.authenticated,
  requireAuth,
  paymentController.getPaymentOrderStatus
);

router.post(
  "/phonepe/create-order",
  rateLimiters.authenticated,
  requireAuth,
  paymentController.createPhonePeOrder
);

router.post(
  "/phonepe/webhook",
  rateLimiters.phonePeWebhook,
  paymentController.phonePeWebhook
);

router.get(
  "/phonepe/order-status/:bookingId",
  rateLimiters.authenticated,
  requireAuth,
  paymentController.getPhonePeOrderStatus
);

export default router;
