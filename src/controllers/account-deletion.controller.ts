import { Request, Response } from "express";
import {
  AccountDeletionReason,
  AccountDeletionStatus,
} from "../generated/prisma";
import { AuthRequest } from "../types/types";
import { AppError } from "../utils/AppError";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { clearAuthCookie } from "../utils/token.util";
import {
  cancelAccountDeletion,
  getAccountDeletionStats,
  getAccountDeletionStatus,
  listAccountDeletionRequests,
  processDueAccountDeletions,
  requestAccountDeletion,
} from "../services/account-deletion.service";

const parseEnumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
  { required = true }: { required?: boolean } = {}
) => {
  if (value == null || value === "") {
    if (!required) {
      return undefined;
    }

    throw new AppError(
      `${fieldName} is required.`,
      400
    );
  }

  if (typeof value !== "string") {
    throw new AppError(
      `Invalid ${fieldName}.`,
      400
    );
  }

  const normalized =
    value.trim().toUpperCase() as T;

  if (!allowed.includes(normalized)) {
    throw new AppError(
      `Invalid ${fieldName}.`,
      400
    );
  }

  return normalized;
};

const parseOptionalDate = (
  value: unknown,
  fieldName: string,
  endOfDay = false
) => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    return null;
  }

  const trimmed = value.trim();
  const date = new Date(trimmed);

  if (Number.isNaN(date.getTime())) {
    throw new AppError(
      `Invalid ${fieldName}.`,
      400
    );
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (endOfDay) {
      date.setHours(23, 59, 59, 999);
    } else {
      date.setHours(0, 0, 0, 0);
    }
  }

  return date;
};

const parsePositiveInt = (
  value: unknown,
  fallback: number,
  max: number
) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(1, Math.floor(parsed)),
    max
  );
};

const getRequestDevice = (req: Request) => {
  const explicitDevice =
    typeof req.body?.device === "string"
      ? req.body.device
      : typeof req.body?.deviceId === "string"
      ? req.body.deviceId
      : typeof req.headers["x-device-id"] ===
        "string"
      ? req.headers["x-device-id"]
      : "";

  const userAgent =
    req.get("user-agent") ?? "";

  return [explicitDevice, userAgent]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" | ");
};

export const requestOwnAccountDeletion =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.user) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      const reason = parseEnumValue(
        req.body?.reason,
        Object.values(
          AccountDeletionReason
        ),
        "reason"
      ) as AccountDeletionReason;

      const feedback =
        typeof req.body?.feedback ===
        "string"
          ? req.body.feedback
          : null;

      const status =
        await requestAccountDeletion({
          userId: req.user.id,
          reason,
          feedback,
          requestIp:
            req.ip ||
            req.socket.remoteAddress ||
            null,
          requestedDevice:
            getRequestDevice(req),
        });

      clearAuthCookie(res);

      res.json(
        successResponse(
          status,
          "Account deletion scheduled. Logging in again within 30 days will cancel this request."
        )
      );
    }
  );

export const cancelOwnAccountDeletion =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.user) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      const status =
        await cancelAccountDeletion({
          userId: req.user.id,
          cancelledByLogin: false,
        });

      res.json(
        successResponse(
          status,
          "Account deletion request cancelled."
        )
      );
    }
  );

export const getOwnAccountDeletionStatus =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.user) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      const status =
        await getAccountDeletionStatus(
          req.user.id
        );

      res.setHeader(
        "Cache-Control",
        "no-store, max-age=0"
      );
      res.setHeader("Pragma", "no-cache");

      res.json(
        successResponse(
          status,
          "Account deletion status fetched."
        )
      );
    }
  );

export const getAdminAccountDeletionRequests =
  catchAsync(
    async (req: Request, res: Response) => {
      const status = parseEnumValue(
        req.query.status,
        Object.values(
          AccountDeletionStatus
        ),
        "status",
        { required: false }
      ) as
        | AccountDeletionStatus
        | undefined;

      const reason = parseEnumValue(
        req.query.reason,
        Object.values(
          AccountDeletionReason
        ),
        "reason",
        { required: false }
      ) as
        | AccountDeletionReason
        | undefined;

      const from = parseOptionalDate(
        req.query.from,
        "from"
      );
      const to = parseOptionalDate(
        req.query.to,
        "to",
        true
      );
      const page = parsePositiveInt(
        req.query.page,
        1,
        10_000
      );
      const pageSize = parsePositiveInt(
        req.query.pageSize,
        20,
        100
      );

      const result =
        await listAccountDeletionRequests(
          {
            ...(status
              ? { status }
              : {}),
            ...(reason
              ? { reason }
              : {}),
            from,
            to,
            page,
            pageSize,
          }
        );

      res.json(
        successResponse(
          result.data,
          "Account deletion requests fetched.",
          result.meta
        )
      );
    }
  );

export const getAdminAccountDeletionStats =
  catchAsync(
    async (req: Request, res: Response) => {
      const from = parseOptionalDate(
        req.query.from,
        "from"
      );
      const to = parseOptionalDate(
        req.query.to,
        "to",
        true
      );

      const stats =
        await getAccountDeletionStats({
          from,
          to,
        });

      res.json(
        successResponse(
          stats,
          "Account deletion statistics fetched."
        )
      );
    }
  );

export const runAccountDeletionJobNow =
  catchAsync(
    async (req: Request, res: Response) => {
      const dryRun =
        req.body?.dryRun === true ||
        req.query.dryRun === "true";
      const limit = parsePositiveInt(
        req.body?.limit ??
          req.query.limit,
        25,
        100
      );

      const result =
        await processDueAccountDeletions({
          dryRun,
          limit,
        });

      res.json(
        successResponse(
          result,
          dryRun
            ? "Account deletion job dry run completed."
            : "Account deletion job completed."
        )
      );
    }
  );
