import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { getDashboardAnalytics } from "../controllers/analytics.controller";

const router = Router();

// Dashboard analytics (role-scoped)
router.get("/dashboard", requireAuth, getDashboardAnalytics);

export default router;

