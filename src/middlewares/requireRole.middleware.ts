import { RequestHandler } from "express";
import { Role } from "../generated/prisma";
import { AppError } from "../utils/AppError";

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req: any, _res, next) => {

    if (!req.user || !roles.includes(req.user.role)) {
      return next(
        new AppError("Forbidden", 403, "FORBIDDEN")
      );
    }

    next();
  };