import jwt from "jsonwebtoken";
import { Response } from "express";
import { config } from "../config/config";

export const signToken = (payload: any) =>
  jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: "30d",
  });

export const setAuthCookie = (
  res: Response,
  token: string
) => {
  const isProd = config.NODE_ENV === "production";
  const sameSite = config.AUTH_COOKIE_SAMESITE;
  const secure = isProd || sameSite === "none";

  res.cookie("authToken", token, {
    httpOnly: true,
    secure,
    sameSite,
    domain: isProd
      ? config.AUTH_COOKIE_DOMAIN
      : undefined,
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
};

export const clearAuthCookie = (
  res: Response
) => {
  const isProd = config.NODE_ENV === "production";
  const sameSite = config.AUTH_COOKIE_SAMESITE;
  const secure = isProd || sameSite === "none";

  res.clearCookie("authToken", {
    httpOnly: true,
    secure,
    sameSite,
    domain: isProd
      ? config.AUTH_COOKIE_DOMAIN
      : undefined,
    path: "/",
  });
};
