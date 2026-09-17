import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import {
  listTrashItems,
  permanentlyDeleteBooking,
  permanentlyDeleteBranch,
  permanentlyDeleteServiceTree,
  permanentlyDeleteUser,
  restoreBookingFromTrash,
  restoreBranchFromTrash,
  restoreServiceTreeFromTrash,
  restoreUserFromTrash,
  TrashEntityType,
} from "../services/trash.service";

const parseTrashEntityType = (
  rawValue: unknown
): TrashEntityType => {
  const value =
    typeof rawValue === "string"
      ? rawValue.trim().toUpperCase()
      : "";

  if (
    value !== "SERVICE" &&
    value !== "USER" &&
    value !== "BRANCH" &&
    value !== "BOOKING"
  ) {
    throw new AppError(
      "Invalid trash entity type",
      400
    );
  }

  return value;
};

const ensureTrashedEntity =
  async (
    entityType: TrashEntityType,
    id: string
  ) => {
    switch (entityType) {
      case "SERVICE":
        return prisma.serviceNode.findFirst({
          where: {
            id,
            deletedAt: {
              not: null,
            },
          },
          select: {
            id: true,
          },
        });
      case "USER":
        return prisma.user.findFirst({
          where: {
            id,
            deletedAt: {
              not: null,
            },
          },
          select: {
            id: true,
          },
        });
      case "BRANCH":
        return prisma.branch.findFirst({
          where: {
            id,
            deletedAt: {
              not: null,
            },
          },
          select: {
            id: true,
          },
        });
      case "BOOKING":
        return prisma.booking.findFirst({
          where: {
            id,
            deletedAt: {
              not: null,
            },
          },
          select: {
            id: true,
          },
        });
      default:
        return null;
    }
  };

export const listTrash =
  catchAsync(
    async (req: Request, res: Response) => {
      const entityTypeRaw =
        req.query.entityType;
      const entityType =
        typeof entityTypeRaw === "string" &&
        entityTypeRaw.trim().length > 0
          ? parseTrashEntityType(
              entityTypeRaw
            )
          : undefined;

      const page = Math.max(
        1,
        Number(req.query.page) || 1
      );
      const pageSize = Math.min(
        Math.max(
          1,
          Number(req.query.pageSize) || 20
        ),
        100
      );
      const search =
        typeof req.query.search ===
        "string"
          ? req.query.search
          : "";

      const result =
        await listTrashItems(
          entityType
            ? {
                entityType,
                search,
                page,
                pageSize,
              }
            : {
                search,
                page,
                pageSize,
              }
        );

      res.json(
        successResponse(
          result.items,
          "Trash items fetched",
          result.meta
        )
      );
    }
  );

export const restoreTrashItem =
  catchAsync(
    async (req: Request, res: Response) => {
      const entityType =
        parseTrashEntityType(
          req.params.entityType
        );
      const id = getParam(
        req.params.id,
        "trashItemId"
      );

      const entity =
        await ensureTrashedEntity(
          entityType,
          id
        );

      if (!entity) {
        throw new AppError(
          "Trash item not found",
          404
        );
      }

      switch (entityType) {
        case "SERVICE":
          await restoreServiceTreeFromTrash(
            id
          );
          break;
        case "USER":
          await restoreUserFromTrash(id);
          break;
        case "BRANCH":
          await restoreBranchFromTrash(id);
          break;
        case "BOOKING":
          await restoreBookingFromTrash(
            id
          );
          break;
      }

      res.json(
        successResponse(
          null,
          `${entityType.toLowerCase()} restored`
        )
      );
    }
  );

export const permanentlyDeleteTrashItem =
  catchAsync(
    async (req: Request, res: Response) => {
      const entityType =
        parseTrashEntityType(
          req.params.entityType
        );
      const id = getParam(
        req.params.id,
        "trashItemId"
      );

      const entity =
        await ensureTrashedEntity(
          entityType,
          id
        );

      if (!entity) {
        throw new AppError(
          "Trash item not found",
          404
        );
      }

      let meta:
        | Record<string, unknown>
        | undefined;

      switch (entityType) {
        case "SERVICE":
          meta =
            await permanentlyDeleteServiceTree(
              id
            );
          break;
        case "USER":
          await permanentlyDeleteUser(id);
          break;
        case "BRANCH":
          await permanentlyDeleteBranch(
            id
          );
          break;
        case "BOOKING":
          await permanentlyDeleteBooking(
            id
          );
          break;
      }

      res.json(
        successResponse(
          null,
          `${entityType.toLowerCase()} permanently deleted`,
          meta
        )
      );
    }
  );
