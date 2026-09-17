import { Request, Response } from "express";
import { BannerSize } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const getBannerIdParam = (value: string | string[] | undefined) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("Banner id is required", 400);
  }
  return value.trim();
};

const BANNER_SIZES = Object.values(BannerSize);

const normalizeBannerSize = (
  value: unknown
): BannerSize | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !BANNER_SIZES.includes(value as BannerSize)
  ) {
    throw new AppError(
      `size must be one of: ${BANNER_SIZES.join(", ")}`,
      400
    );
  }
  return value as BannerSize;
};

const parseBannerSizeQuery = (
  value: unknown
): BannerSize | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (!BANNER_SIZES.includes(value as BannerSize)) {
    throw new AppError(
      `size must be one of: ${BANNER_SIZES.join(", ")}`,
      400
    );
  }
  return value as BannerSize;
};

const normalizeOptionalString = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new AppError("Invalid value provided", 400);
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const normalizeOptionalDate = (
  value: unknown,
  field: string
): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return date;
};

//////////////////////////////////////////////////////
// PUBLIC: LIST ACTIVE BANNERS (STOREFRONT)
//////////////////////////////////////////////////////

export const listPublicBanners = catchAsync(
  async (req: Request, res: Response) => {
    const now = new Date();
    const size = parseBannerSizeQuery(req.query.size);

    const banners = await prisma.banner.findMany({
      where: {
        isActive: true,
        ...(size ? { size } : {}),
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
        ],
      },
      orderBy: { sortOrder: "asc" },
    });

    res.json(successResponse(banners));
  }
);

//////////////////////////////////////////////////////
// ADMIN: LIST ALL BANNERS
//////////////////////////////////////////////////////

export const adminListBanners = catchAsync(
  async (req: Request, res: Response) => {
    const size = parseBannerSizeQuery(req.query.size);

    const banners = await prisma.banner.findMany({
      where: size ? { size } : {},
      orderBy: { sortOrder: "asc" },
    });

    res.json(successResponse(banners));
  }
);

//////////////////////////////////////////////////////
// ADMIN: CREATE BANNER
//////////////////////////////////////////////////////

export const createBanner = catchAsync(
  async (req: Request, res: Response) => {
    const imageUrl =
      typeof req.body?.imageUrl === "string" ? req.body.imageUrl.trim() : "";

    if (!imageUrl) {
      throw new AppError("imageUrl is required", 400);
    }

    const size = normalizeBannerSize(req.body?.size) ?? BannerSize.HERO;

    const maxSortOrder = await prisma.banner.aggregate({
      where: { size },
      _max: { sortOrder: true },
    });

    const banner = await prisma.banner.create({
      data: {
        size,
        title: normalizeOptionalString(req.body?.title) ?? null,
        subtitle: normalizeOptionalString(req.body?.subtitle) ?? null,
        ctaLabel: normalizeOptionalString(req.body?.ctaLabel) ?? null,
        linkUrl: normalizeOptionalString(req.body?.linkUrl) ?? null,
        imageUrl,
        isActive:
          typeof req.body?.isActive === "boolean" ? req.body.isActive : true,
        startsAt:
          normalizeOptionalDate(req.body?.startsAt, "startsAt") ?? null,
        expiresAt:
          normalizeOptionalDate(req.body?.expiresAt, "expiresAt") ?? null,
        sortOrder: (maxSortOrder._max.sortOrder ?? -1) + 1,
      },
    });

    res.json(successResponse(banner, "Banner created"));
  }
);

//////////////////////////////////////////////////////
// ADMIN: UPDATE BANNER
//////////////////////////////////////////////////////

export const updateBanner = catchAsync(
  async (req: Request, res: Response) => {
    const id = getBannerIdParam(req.params.id);

    const existing = await prisma.banner.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError("Banner not found", 404);
    }

    let imageUrl: string | undefined;
    if (req.body?.imageUrl !== undefined) {
      const trimmed =
        typeof req.body.imageUrl === "string" ? req.body.imageUrl.trim() : "";
      if (!trimmed) {
        throw new AppError("imageUrl is required", 400);
      }
      imageUrl = trimmed;
    }

    const banner = await prisma.banner.update({
      where: { id },
      data: {
        ...(req.body?.title !== undefined
          ? { title: normalizeOptionalString(req.body.title) ?? null }
          : {}),
        ...(req.body?.subtitle !== undefined
          ? { subtitle: normalizeOptionalString(req.body.subtitle) ?? null }
          : {}),
        ...(req.body?.ctaLabel !== undefined
          ? { ctaLabel: normalizeOptionalString(req.body.ctaLabel) ?? null }
          : {}),
        ...(req.body?.linkUrl !== undefined
          ? { linkUrl: normalizeOptionalString(req.body.linkUrl) ?? null }
          : {}),
        ...(imageUrl !== undefined ? { imageUrl } : {}),
        ...(typeof req.body?.isActive === "boolean"
          ? { isActive: req.body.isActive }
          : {}),
        ...(req.body?.startsAt !== undefined
          ? {
              startsAt:
                normalizeOptionalDate(req.body.startsAt, "startsAt") ?? null,
            }
          : {}),
        ...(req.body?.expiresAt !== undefined
          ? {
              expiresAt:
                normalizeOptionalDate(req.body.expiresAt, "expiresAt") ??
                null,
            }
          : {}),
      },
    });

    res.json(successResponse(banner, "Banner updated"));
  }
);

//////////////////////////////////////////////////////
// ADMIN: DELETE BANNER
//////////////////////////////////////////////////////

export const deleteBanner = catchAsync(
  async (req: Request, res: Response) => {
    const id = getBannerIdParam(req.params.id);

    const existing = await prisma.banner.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError("Banner not found", 404);
    }

    await prisma.banner.delete({ where: { id } });

    res.json(successResponse(null, "Banner deleted"));
  }
);

//////////////////////////////////////////////////////
// ADMIN: REORDER BANNERS
//////////////////////////////////////////////////////

export const reorderBanners = catchAsync(
  async (req: Request, res: Response) => {
    const orderedIdsRaw = req.body?.orderedIds;
    const size = normalizeBannerSize(req.body?.size) ?? BannerSize.HERO;

    if (!Array.isArray(orderedIdsRaw) || !orderedIdsRaw.length) {
      throw new AppError("orderedIds must be a non-empty array", 400);
    }

    const orderedIds = orderedIdsRaw.map((value: unknown, index: number) => {
      if (typeof value !== "string" || !value.trim()) {
        throw new AppError(`orderedIds[${index}] is invalid`, 400);
      }
      return value.trim();
    });

    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new AppError("orderedIds contains duplicates", 400);
    }

    const existing = await prisma.banner.findMany({
      where: { id: { in: orderedIds } },
      select: { id: true, size: true },
    });

    if (existing.length !== orderedIds.length) {
      throw new AppError("One or more banners could not be found", 404);
    }

    if (existing.some((banner) => banner.size !== size)) {
      throw new AppError(
        "Banners can only be reordered within the same size group",
        400
      );
    }

    const siblingCount = await prisma.banner.count({ where: { size } });
    if (siblingCount !== orderedIds.length) {
      throw new AppError(
        "Reordering requires the full banner list for this size",
        400
      );
    }

    await prisma.$transaction(
      orderedIds.map((id: string, index: number) =>
        prisma.banner.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );

    const banners = await prisma.banner.findMany({
      where: { size },
      orderBy: { sortOrder: "asc" },
    });

    res.json(successResponse(banners, "Banners reordered"));
  }
);
