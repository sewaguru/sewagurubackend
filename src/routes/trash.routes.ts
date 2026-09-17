import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireSuperAdmin } from "../middlewares/permissions.middleware";
import {
  listTrash,
  permanentlyDeleteTrashItem,
  restoreTrashItem,
} from "../controllers/trash.controller";

const router = Router();

router.get(
  "/",
  requireAuth,
  requireSuperAdmin,
  listTrash
);

router.post(
  "/:entityType/:id/restore",
  requireAuth,
  requireSuperAdmin,
  restoreTrashItem
);

router.delete(
  "/:entityType/:id/permanent",
  requireAuth,
  requireSuperAdmin,
  permanentlyDeleteTrashItem
);

export default router;
