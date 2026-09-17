import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  getMyCart,
  addItemToCart,
  updateCartItemQuantity,
  removeCartItem,
  clearCart,
  previewCartCheckout,
  checkoutCartToBooking,
} from "../controllers/cart.controller";

const router = Router();

//////////////////////////////////////////////////////
// CART ITEMS
//////////////////////////////////////////////////////

router.get(
  "/",
  requireAuth,
  getMyCart
);

router.post(
  "/items",
  requireAuth,
  addItemToCart
);

router.patch(
  "/items/:itemId",
  requireAuth,
  updateCartItemQuantity
);

router.delete(
  "/items/:itemId",
  requireAuth,
  removeCartItem
);

router.delete(
  "/",
  requireAuth,
  clearCart
);

//////////////////////////////////////////////////////
// CHECKOUT
//////////////////////////////////////////////////////

router.post(
  "/preview",
  requireAuth,
  previewCartCheckout
);

router.post(
  "/checkout",
  requireAuth,
  checkoutCartToBooking
);

export default router;
