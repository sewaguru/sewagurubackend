import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { config } from "../config/config";

export type GoogleAuthUser = {
  email: string;
  name: string;
  picture: string | null;
  googleId: string;
};

let strategyInitialized = false;

export const initializeGoogleStrategy = () => {
  if (!config.AUTH_GOOGLE_ENABLED || strategyInitialized) {
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: config.GOOGLE_CALLBACK_URL,
        scope: ["profile", "email"],
      },
      (_accessToken, _refreshToken, profile, done) => {
        const email = profile.emails?.[0]?.value?.trim().toLowerCase();

        if (!email) {
          return done(
            new Error("Google account does not have a verified email")
          );
        }

        const payload: GoogleAuthUser = {
          email,
          name: profile.displayName?.trim() || "Google User",
          picture: profile.photos?.[0]?.value ?? null,
          googleId: profile.id,
        };

        return done(
          null,
          payload as unknown as Express.User
        );
      }
    )
  );

  strategyInitialized = true;
};
