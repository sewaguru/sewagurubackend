import { Router } from "express";
import { upload } from "../middlewares/upload.middleware";

import {
  createFolder,
  updateFolder,
  deleteFolder,
  getFolders,
  uploadMedia,
  deleteMedia,
  getMediaByFolder,
  moveMedia,
  getFolderById,
  renameMedia,
} from "../controllers/media.controller";

import { requireAuth } from "../middlewares/auth.middleware";
import {
  requireSuperAdmin,
  requireBranchOperator,
} from "../middlewares/permissions.middleware";

const router = Router();

//////////////////////////////////////////////////////
// FOLDERS
//////////////////////////////////////////////////////

router.post(
  "/folders",
  requireAuth,
  requireSuperAdmin,
  createFolder
);

router.get(
  "/folders",
  requireAuth,
  getFolders
);

router.put(
  "/folders/:id",
  requireAuth,
  requireSuperAdmin,
  updateFolder
);

router.delete(
  "/folders/:id",
  requireAuth,
  requireSuperAdmin,
  deleteFolder
);

//////////////////////////////////////////////////////
// MEDIA
//////////////////////////////////////////////////////

router.post(
  "/upload",
  requireAuth,
  requireBranchOperator,
  upload.single("file"),
  uploadMedia
);

router.get(
  "/folders/:id",
  requireAuth,
  getFolderById
);

router.get(
  "/folders/:id/media",
  requireAuth,
  getMediaByFolder
);

router.patch(
  "/move",
  requireAuth,
  requireBranchOperator,
  moveMedia
);

router.delete(
  "/:id",
  requireAuth,
  requireBranchOperator,
  deleteMedia
);

router.put(
  "/:id",
  requireAuth,
  requireBranchOperator,
  renameMedia
);

export default router;
