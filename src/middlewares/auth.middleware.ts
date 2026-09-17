import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { AuthRequest } from "../types/types";
import { config } from "../config/config";
import { AppError } from "../utils/AppError";

interface JwtPayload {
  id: string;
}

const LAST_ACTIVE_TOUCH_INTERVAL_MS =
  6 * 60 * 60 * 1000;

const extractAuthToken = (
  req: AuthRequest
) => {
  const cookieToken =
    req.cookies?.authToken;

  if (
    typeof cookieToken === "string" &&
    cookieToken.trim()
  ) {
    return cookieToken.trim();
  }

  const authorizationHeader =
    req.headers.authorization;

  if (
    typeof authorizationHeader ===
    "string"
  ) {
    const [scheme, token] =
      authorizationHeader.split(" ");

    if (
      scheme?.toLowerCase() ===
        "bearer" &&
      typeof token === "string" &&
      token.trim()
    ) {
      return token.trim();
    }
  }

  return null;
};

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const token = extractAuthToken(req);

  if (!token) {
    return next(
      new AppError("Unauthorized", 401, "UNAUTHORIZED")
    );
  }

  try {
    const decoded = jwt.verify(
      token,
      config.JWT_SECRET
    ) as JwtPayload;

    //////////////////////////////////////////////////
    // LOAD USER FROM DB
    //////////////////////////////////////////////////
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        role: true,
        isBlocked: true,
        isActive: true,
        deletedAt: true,
        lastActiveAt: true,
        deletionStatus: true,
      },
    });

    if (!user) {
      return next(
        new AppError("User not found", 401, "UNAUTHORIZED")
      );
    }

    if (user.deletionStatus === "COMPLETED") {
      return next(
        new AppError(
          "This account has been permanently deleted.",
          410,
          "ACCOUNT_DELETED"
        )
      );
    }

    if (
      user.isBlocked ||
      !user.isActive ||
      user.deletedAt
    ) {
      return next(
        new AppError(
          "Account is blocked",
          403,
          "ACCOUNT_BLOCKED"
        )
      );
    }

    req.user = {
      id: user.id,
      role: user.role,
    };

    const shouldTouchLastActive =
      !user.lastActiveAt ||
      Date.now() -
        user.lastActiveAt.getTime() >
        LAST_ACTIVE_TOUCH_INTERVAL_MS;

    if (shouldTouchLastActive) {
      void prisma.user
        .update({
          where: { id: user.id },
          data: {
            lastActiveAt:
              new Date(),
          },
        })
        .catch((error) => {
          console.error(
            "[AUTH] Failed to update lastActiveAt",
            {
              userId: user.id,
              error,
            }
          );
        });
    }

    next();
  } catch {
    return next(
      new AppError("Session expired", 401, "SESSION_EXPIRED")
    );
  }
};
