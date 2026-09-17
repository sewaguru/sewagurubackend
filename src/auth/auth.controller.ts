import crypto from "crypto";
import { Request, Response } from "express";
import jwt, { JwtHeader, SigningKeyCallback } from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { catchAsync } from "../utils/catchAsync";
import { config } from "../config/config";
import { setAuthCookie, signToken } from "../utils/token.util";
import { securityLog } from "../utils/security.util";
import { successResponse } from "../utils/response.util";
import { GoogleAuthUser } from "./google.strategy";
import {
  assertIdentifierNotPermanentlyDeleted,
  resolveAccountDeletionOnLogin,
} from "../services/account-deletion.service";

const GOOGLE_OAUTH_STATE_COOKIE = "googleOauthState";
const GOOGLE_POST_LOGIN_REDIRECT_COOKIE = "googlePostLoginRedirect";

const isSafeRedirectPath = (value: string | null | undefined) => {
  if (!value) return false;
  return value.startsWith("/") && !value.startsWith("//");
};

const getFrontendRedirect = (path: string) => {
  const safeBase = config.CLIENT_URL || "http://localhost:3000";
  return `${safeBase.replace(/\/+$/, "")}${path}`;
};

export const getGoogleAuthStartParams = (req: Request) => {
  const redirectParam =
    typeof req.query.redirect === "string"
      ? req.query.redirect
      : undefined;

  const requestedRedirect = isSafeRedirectPath(redirectParam)
    ? redirectParam!
    : "/";

  const state = crypto.randomBytes(24).toString("hex");

  return {
    state,
    requestedRedirect,
  };
};

export const setGoogleAuthCookies = (
  res: Response,
  state: string,
  redirectPath: string
) => {
  const isProd = config.NODE_ENV === "production";
  const sameSite = config.AUTH_COOKIE_SAMESITE;
  const secure = isProd || sameSite === "none";

  res.cookie(GOOGLE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: 10 * 60 * 1000,
    path: "/",
  });

  res.cookie(GOOGLE_POST_LOGIN_REDIRECT_COOKIE, redirectPath, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
};

const clearGoogleAuthCookies = (res: Response) => {
  const isProd = config.NODE_ENV === "production";
  const sameSite = config.AUTH_COOKIE_SAMESITE;
  const secure = isProd || sameSite === "none";

  const sharedOptions = {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
  } as const;

  res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, sharedOptions);
  res.clearCookie(GOOGLE_POST_LOGIN_REDIRECT_COOKIE, sharedOptions);
};

const upsertGoogleUser = async (googleUser: GoogleAuthUser) => {
  // Migration-safe approach:
  // link users by verified email so Google login works even before DB enum updates.
  const userByEmail = await prisma.userAuth.findFirst({
    where: {
      identifierType: "EMAIL",
      identifier: googleUser.email,
    },
    include: { user: { include: { profile: true } } },
  });

  if (userByEmail) {
    const linkedUser = await prisma.user.update({
      where: { id: userByEmail.userId },
      data: {
        profile: {
          upsert: {
            update: {
              fullName: userByEmail.user.profile?.fullName || googleUser.name,
              ...(userByEmail.user.profile?.profileImageUrl ||
              googleUser.picture
                ? {
                    profileImageUrl:
                      userByEmail.user.profile?.profileImageUrl ||
                      googleUser.picture,
                  }
                : {}),
            },
            create: {
              fullName: googleUser.name,
              email: googleUser.email,
              ...(googleUser.picture
                ? { profileImageUrl: googleUser.picture }
                : {}),
            },
          },
        },
      },
    });

    return linkedUser;
  }

  await assertIdentifierNotPermanentlyDeleted({
    identifier: googleUser.email,
    identifierType: "EMAIL",
  });

  return prisma.user.create({
    data: {
      authMethods: {
        create: {
          provider: "EMAIL_OTP",
          identifierType: "EMAIL",
          identifier: googleUser.email,
          isPrimary: true,
          isVerified: true,
        },
      },
      profile: {
        create: {
          fullName: googleUser.name,
          email: googleUser.email,
          ...(googleUser.picture
            ? { profileImageUrl: googleUser.picture }
            : {}),
        },
      },
    },
  });
};

export const handleGoogleAuthSuccess = catchAsync(
  async (req: Request, res: Response) => {
    const stateFromQuery =
      typeof req.query.state === "string" ? req.query.state : "";
    const stateFromCookie = req.cookies?.[GOOGLE_OAUTH_STATE_COOKIE] ?? "";
    const redirectFromCookie =
      req.cookies?.[GOOGLE_POST_LOGIN_REDIRECT_COOKIE] ?? "/";

    clearGoogleAuthCookies(res);

    if (!stateFromQuery || stateFromQuery !== stateFromCookie) {
      throw new AppError("Invalid OAuth state", 400, "OAUTH_STATE_INVALID");
    }

    const googleUser = req.user as GoogleAuthUser | undefined;

    if (!googleUser) {
      throw new AppError("Google authentication failed", 401);
    }

    const user = await upsertGoogleUser(googleUser);

    const deletionCancellation =
      await resolveAccountDeletionOnLogin(
        user.id
      );

    if (user.isBlocked || !user.isActive || user.deletedAt) {
      throw new AppError("Account is blocked", 403);
    }

    const token = signToken({
      id: user.id,
      role: user.role,
    });

    setAuthCookie(res, token);

    const redirectPath = isSafeRedirectPath(redirectFromCookie)
      ? redirectFromCookie
      : "/";
    const deletionCancelledParam =
      deletionCancellation.cancelled
        ? "&accountDeletionCancelled=1"
        : "";
    const redirectTarget = getFrontendRedirect(
      `/login?google=success&redirect=${encodeURIComponent(redirectPath)}${deletionCancelledParam}`
    );

    return res.redirect(302, redirectTarget);
  }
);

export const handleGoogleAuthFailure = (
  _req: Request,
  res: Response
) => {
  clearGoogleAuthCookies(res);
  const redirectTarget = getFrontendRedirect(
    "/login?google=failed"
  );
  return res.redirect(302, redirectTarget);
};

//////////////////////////////////////////////////////
// MOBILE: Verify Google ID token
// Called by the Flutter app after google_sign_in.
//////////////////////////////////////////////////////

const googleOAuthClient = new OAuth2Client(config.GOOGLE_CLIENT_ID);

export const verifyGoogleMobileToken = catchAsync(
  async (req: Request, res: Response) => {
    const { idToken } = req.body as { idToken?: unknown };

    if (!idToken || typeof idToken !== "string") {
      throw new AppError("idToken is required", 400);
    }

    let email: string;
    let name: string;
    let picture: string | null;
    let googleId: string;

    try {
      const ticket = await googleOAuthClient.verifyIdToken({
        idToken,
        audience: config.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();

      if (!payload) throw new Error("Empty token payload");
      if (!payload.email_verified || !payload.email) {
        throw new AppError("Google account email is not verified", 400);
      }

      email = payload.email.toLowerCase().trim();
      name = (payload.name ?? "Google User").trim();
      picture = payload.picture ?? null;
      googleId = payload.sub;
    } catch (err) {
      if (err instanceof AppError) throw err;
      securityLog("LOGIN_FAILED", {
        identifier: "google-mobile",
        type: "USER",
        otpReason: "GOOGLE_TOKEN_INVALID",
      });
      throw new AppError("Invalid Google ID token", 401);
    }

    const googleUser: GoogleAuthUser = { email, name, picture, googleId };
    const user = await upsertGoogleUser(googleUser);

    const deletionCancellation =
      await resolveAccountDeletionOnLogin(
        user.id
      );

    if (user.isBlocked || !user.isActive || user.deletedAt) {
      throw new AppError("Account is blocked", 403);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    const token = signToken({ id: user.id, role: user.role });
    setAuthCookie(res, token);

    securityLog("USER_LOGIN", {
      userId: user.id,
      role: user.role,
      identifierType: "GOOGLE_MOBILE",
    });

    res.json(
      successResponse(
        user,
        "Login successful",
        deletionCancellation.cancelled
          ? {
              accountDeletionCancelled: true,
              accountDeletionCancellationMessage:
                deletionCancellation.message,
            }
          : undefined
      )
    );
  }
);

//////////////////////////////////////////////////////
// MOBILE: Verify Apple identity token
// Called by the Flutter app after sign_in_with_apple (native iOS flow).
//
// No Service ID and no private "Sign in with Apple" key are needed here —
// the native flow's identity token has an audience equal to the app's own
// bundle id, and its signature is checked against Apple's public keys.
//////////////////////////////////////////////////////

const APPLE_ISSUER = "https://appleid.apple.com";

const appleKeyClient = jwksClient({
  jwksUri: `${APPLE_ISSUER}/auth/keys`,
  cache: true,
  cacheMaxAge: 12 * 60 * 60 * 1000, // Apple rotates signing keys infrequently
  rateLimit: true,
});

const getAppleSigningKey = (
  header: JwtHeader,
  callback: SigningKeyCallback
) => {
  appleKeyClient.getSigningKey(header.kid, (err, key) => {
    if (err || !key) {
      callback(err ?? new Error("Apple signing key not found"));
      return;
    }
    callback(null, key.getPublicKey());
  });
};

interface ApplePayload {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
}

const verifyAppleIdentityToken = (
  identityToken: string
): Promise<ApplePayload> => {
  return new Promise((resolve, reject) => {
    jwt.verify(
      identityToken,
      getAppleSigningKey,
      {
        algorithms: ["RS256"],
        issuer: APPLE_ISSUER,
        audience: config.APPLE_BUNDLE_ID,
      },
      (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          reject(err ?? new Error("Invalid Apple identity token"));
          return;
        }
        resolve(decoded as unknown as ApplePayload);
      }
    );
  });
};

interface AppleAuthUser {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  // Only ever present on the user's first-ever authorization for this app —
  // Apple does not resend it on later sign-ins.
  fullName: string | null;
}

const upsertAppleUser = async (appleUser: AppleAuthUser) => {
  // 1) We've already linked this Apple account before — this is the path
  // every sign-in after the first takes, including ones where Apple omits
  // email entirely.
  const bySub = await prisma.userAuth.findFirst({
    where: {
      provider: "APPLE",
      identifierType: "APPLE_SUB",
      identifier: appleUser.sub,
    },
    include: { user: { include: { profile: true, authMethods: true } } },
  });

  if (bySub) {
    if (!appleUser.fullName) {
      return bySub.user;
    }

    return prisma.user.update({
      where: { id: bySub.userId },
      data: {
        profile: {
          upsert: {
            update: {
              // Apple only sends the name once; never overwrite a name we
              // already have with a blank one on a later login.
              fullName: bySub.user.profile?.fullName || appleUser.fullName,
            },
            create: {
              fullName: appleUser.fullName,
              ...(appleUser.email ? { email: appleUser.email } : {}),
            },
          },
        },
      },
      include: { profile: true, authMethods: true },
    });
  }

  // 2) First time we've seen this Apple "sub". Migration-safe approach,
  // mirroring upsertGoogleUser: link by verified email if an account
  // already exists (phone/email/Google), so Apple doesn't create a second,
  // disconnected account for a user who already has one.
  const userByEmail = appleUser.email
    ? await prisma.userAuth.findFirst({
        where: { identifierType: "EMAIL", identifier: appleUser.email },
        include: { user: { include: { profile: true } } },
      })
    : null;

  // UserProfile.email is globally unique, but a user can have it set there
  // (e.g. via profile edit) without ever having a matching UserAuth EMAIL
  // row — upsertGoogleUser's approach above misses that case. Skipping this
  // check would let the "brand new user" branch below try to INSERT a
  // profile with an email that already exists elsewhere, which Postgres
  // rejects (P2002) and the client sees as a generic "server issue".
  const userByProfileEmail =
    !userByEmail && appleUser.email
      ? await prisma.user.findFirst({
          where: { profile: { email: appleUser.email } },
          include: { profile: true },
        })
      : null;

  const existingUserId = userByEmail?.userId ?? userByProfileEmail?.id;
  const existingProfile = userByEmail?.user.profile ?? userByProfileEmail?.profile;

  if (existingUserId) {
    await prisma.userAuth.create({
      data: {
        userId: existingUserId,
        provider: "APPLE",
        identifierType: "APPLE_SUB",
        identifier: appleUser.sub,
        isVerified: true,
      },
    });

    return prisma.user.update({
      where: { id: existingUserId },
      data: {
        profile: {
          upsert: {
            update: {
              fullName: existingProfile?.fullName || appleUser.fullName || "Apple User",
            },
            create: {
              fullName: appleUser.fullName || "Apple User",
              email: appleUser.email!,
            },
          },
        },
      },
      include: { profile: true, authMethods: true },
    });
  }

  // 3) Brand new user.
  if (appleUser.email) {
    await assertIdentifierNotPermanentlyDeleted({
      identifier: appleUser.email,
      identifierType: "EMAIL",
    });
  }

  return prisma.user.create({
    data: {
      authMethods: {
        create: [
          {
            provider: "APPLE",
            identifierType: "APPLE_SUB",
            identifier: appleUser.sub,
            isPrimary: true,
            isVerified: true,
          },
          // Also register the (possibly private-relay) email as an
          // EMAIL_OTP identity, same as a fresh Google sign-up does, so the
          // account is reachable through the regular email OTP flow too.
          ...(appleUser.email
            ? [
                {
                  provider: "EMAIL_OTP" as const,
                  identifierType: "EMAIL" as const,
                  identifier: appleUser.email,
                  isVerified: appleUser.emailVerified,
                },
              ]
            : []),
        ],
      },
      profile: {
        create: {
          fullName: appleUser.fullName || "Apple User",
          ...(appleUser.email ? { email: appleUser.email } : {}),
        },
      },
    },
    include: { profile: true, authMethods: true },
  });
};

export const verifyAppleMobileToken = catchAsync(
  async (req: Request, res: Response) => {
    const { identityToken, fullName } = req.body as {
      identityToken?: unknown;
      fullName?: unknown;
    };

    if (!identityToken || typeof identityToken !== "string") {
      throw new AppError("identityToken is required", 400);
    }

    let sub: string;
    let email: string | null;
    let emailVerified: boolean;

    try {
      const payload = await verifyAppleIdentityToken(identityToken);
      sub = payload.sub;
      email = payload.email
        ? payload.email.toLowerCase().trim()
        : null;
      emailVerified =
        payload.email_verified === true ||
        payload.email_verified === "true";
    } catch (err) {
      securityLog("LOGIN_FAILED", {
        identifier: "apple-mobile",
        type: "USER",
        otpReason: "APPLE_TOKEN_INVALID",
      });
      throw new AppError("Invalid Apple identity token", 401);
    }

    const trimmedFullName =
      typeof fullName === "string" && fullName.trim()
        ? fullName.trim()
        : null;

    let user;
    try {
      user = await upsertAppleUser({
        sub,
        email,
        emailVerified,
        fullName: trimmedFullName,
      });
    } catch (err) {
      // The global error handler masks any Prisma error as a generic
      // "Database error" for the client — log the actual code/detail here
      // (never the identity token or other PII) so it's diagnosable from
      // the logs alone, in every environment. Different Prisma error codes
      // put their detail in different `meta` fields — P2002 uses `target`,
      // P2007 (data validation error, e.g. an enum value the DB doesn't
      // have yet) uses `database_error` — so capture both rather than
      // assuming one shape.
      const prismaCode = (err as { code?: string })?.code;
      const meta = (err as { meta?: Record<string, unknown> })?.meta;
      securityLog("LOGIN_FAILED", {
        identifier: "apple-mobile",
        type: "USER",
        otpReason: "APPLE_UPSERT_FAILED",
        prismaCode: prismaCode ?? "unknown",
        prismaTarget: meta?.target ?? "unknown",
        prismaDatabaseError: meta?.database_error ?? "unknown",
      });
      throw err;
    }

    const deletionCancellation = await resolveAccountDeletionOnLogin(
      user.id
    );

    if (user.isBlocked || !user.isActive || user.deletedAt) {
      throw new AppError("Account is blocked", 403);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    const token = signToken({ id: user.id, role: user.role });
    setAuthCookie(res, token);

    securityLog("USER_LOGIN", {
      userId: user.id,
      role: user.role,
      identifierType: "APPLE_MOBILE",
    });

    res.json(
      successResponse(
        user,
        "Login successful",
        deletionCancellation.cancelled
          ? {
              accountDeletionCancelled: true,
              accountDeletionCancellationMessage:
                deletionCancellation.message,
            }
          : undefined
      )
    );
  }
);
