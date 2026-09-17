import { NextFunction, Request, Response, Router } from "express";
import passport from "passport";
import { config } from "../config/config";
import { rateLimiters } from "../middlewares/rateLimit.middleware";
import {
  getGoogleAuthStartParams,
  handleGoogleAuthFailure,
  handleGoogleAuthSuccess,
  setGoogleAuthCookies,
  verifyGoogleMobileToken,
  verifyAppleMobileToken,
} from "./auth.controller";

const router = Router();

if (config.AUTH_GOOGLE_ENABLED) {
  router.get("/google", (req, res, next) => {
    const { state, requestedRedirect } = getGoogleAuthStartParams(req);
    setGoogleAuthCookies(res, state, requestedRedirect);

    passport.authenticate("google", {
      session: false,
      state,
      scope: ["profile", "email"],
    })(req, res, next);
  });

  router.get(
    "/google/callback",
    passport.authenticate("google", {
      session: false,
      failWithError: true,
    }),
    handleGoogleAuthSuccess,
    (
      _err: unknown,
      req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      return handleGoogleAuthFailure(req, res);
    }
  );

  // Mobile app: exchange a Google ID token for an app session cookie.
  router.post(
    "/google/verify-token",
    rateLimiters.otpVerify,
    verifyGoogleMobileToken
  );
}

if (config.AUTH_APPLE_ENABLED) {
  // Mobile app: exchange an Apple identity token for an app session cookie.
  router.post(
    "/apple/verify-token",
    rateLimiters.otpVerify,
    verifyAppleMobileToken
  );
}

export default router;
