import { Response } from "express";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { AuthRequest } from "../types/types";
import {
  getBranchBookingScheduleById,
  replaceBranchBookingSchedule,
  serializeBranchBookingSchedule,
} from "../services/branchBookingSchedule.service";

const getManagedBranchIds = async (
  userId: string
) => {
  const assignments =
    await prisma.branchAdmin.findMany({
      where: { userId },
      select: { branchId: true },
    });

  return assignments.map(
    (assignment) =>
      assignment.branchId
  );
};

const assertCanManageBranchSchedule =
  async (
    req: AuthRequest,
    branchId: string
  ) => {
    if (!req.user) {
      throw new AppError(
        "Unauthorized",
        401
      );
    }

    if (req.user.role === "SUPER_ADMIN") {
      return;
    }

    const managedBranchIds =
      await getManagedBranchIds(
        req.user.id
      );

    if (
      !managedBranchIds.includes(
        branchId
      )
    ) {
      throw new AppError(
        "Forbidden",
        403
      );
    }
  };

export const getBranchBookingSettings =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const branchId = getParam(
        req.params.id,
        "branchId"
      );

      await assertCanManageBranchSchedule(
        req,
        branchId
      );

      const schedule =
        await getBranchBookingScheduleById(
          branchId
        );

      res.json(
        successResponse(
          serializeBranchBookingSchedule(
            schedule
          ),
          "Booking settings fetched"
        )
      );
    }
  );

export const updateBranchBookingSettings =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const branchId = getParam(
        req.params.id,
        "branchId"
      );

      await assertCanManageBranchSchedule(
        req,
        branchId
      );

      const schedule =
        await replaceBranchBookingSchedule(
          {
            branchId,
            settings:
              (req.body?.settings ??
                req.body) as Record<
                string,
                unknown
              >,
            closures: Array.isArray(
              req.body?.closures
            )
              ? req.body.closures
              : [],
          }
        );

      res.json(
        successResponse(
          serializeBranchBookingSchedule(
            schedule
          ),
          "Booking settings updated"
        )
      );
    }
  );

export const getPublicBranchBookingSettings =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const branchId = getParam(
        req.params.id,
        "branchId"
      );

      const schedule =
        await getBranchBookingScheduleById(
          branchId
        );

      if (!schedule.branch.isActive) {
        throw new AppError(
          "Selected branch is not available",
          404,
          "BRANCH_NOT_AVAILABLE"
        );
      }

      res.json(
        successResponse(
          serializeBranchBookingSchedule(
            schedule
          ),
          "Public booking settings fetched"
        )
      );
    }
  );
