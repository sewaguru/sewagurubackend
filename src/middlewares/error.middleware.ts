import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError";
import { errorResponse } from "../utils/response.util";
import { config } from "../config/config";

export const globalErrorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {

  //////////////////////////////////////////////////
  // APP ERROR
  //////////////////////////////////////////////////
  if (err instanceof AppError) {
    const isExpectedAuthError =
      err.statusCode === 401 &&
      (err.code ===
        "SESSION_EXPIRED" ||
        err.code ===
          "UNAUTHORIZED");
    const shouldLogOperationalError =
      err.statusCode >= 500 ||
      err.code?.startsWith("PHONEPE") ||
      err.code?.startsWith("SMS") ||
      err.code?.startsWith("EMAIL");

    if (shouldLogOperationalError) {
      // eslint-disable-next-line no-console
      console.error("App error:", {
        message: err.message,
        statusCode: err.statusCode,
        code: err.code,
      });
    } else if (
      config.NODE_ENV !== "production" &&
      !isExpectedAuthError
    ) {
      // eslint-disable-next-line no-console
      console.warn("App error:", {
        message: err.message,
        statusCode: err.statusCode,
        code: err.code,
      });
    }

    return res.status(err.statusCode).json(
      errorResponse(err.message, err.code)
    );
  }

  //////////////////////////////////////////////////
  // PRISMA ERROR
  //////////////////////////////////////////////////
  if (err.code?.startsWith?.("P")) {
    if (config.NODE_ENV !== "production") {
      // Log full prisma error details in non-production for easier debugging
      // eslint-disable-next-line no-console
      console.error("Prisma error:", err);
    }

    return res.status(400).json(
      errorResponse(
        "Database error",
        "DB_ERROR"
      )
    );
  }

  //////////////////////////////////////////////////
  // UNKNOWN ERROR
  //////////////////////////////////////////////////
  if (config.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.error("Unknown error:", err);
  }

  res.status(500).json(
    errorResponse(
      "Internal server error",
      "INTERNAL_ERROR"
    )
  );
};
