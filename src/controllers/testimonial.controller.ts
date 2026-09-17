import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const getTestimonialIdParam = (
  value: string | string[] | undefined
) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("Testimonial id is required", 400);
  }
  return value.trim();
};

const normalizeOptionalString = (
  value: unknown
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new AppError("Invalid value provided", 400);
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const normalizeOptionalRating = (
  value: unknown
): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError("rating must be an integer from 1 to 5", 400);
  }
  return rating;
};

//////////////////////////////////////////////////////
// PUBLIC: LIST ACTIVE TESTIMONIALS (STOREFRONT)
//////////////////////////////////////////////////////

export const listPublicTestimonials = catchAsync(
  async (_req: Request, res: Response) => {
    const testimonials = await prisma.testimonial.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });

    res.json(successResponse(testimonials));
  }
);

//////////////////////////////////////////////////////
// ADMIN: LIST ALL TESTIMONIALS
//////////////////////////////////////////////////////

export const adminListTestimonials = catchAsync(
  async (_req: Request, res: Response) => {
    const testimonials = await prisma.testimonial.findMany({
      orderBy: { sortOrder: "asc" },
    });

    res.json(successResponse(testimonials));
  }
);

//////////////////////////////////////////////////////
// ADMIN: CREATE TESTIMONIAL
//////////////////////////////////////////////////////

export const createTestimonial = catchAsync(
  async (req: Request, res: Response) => {
    const customerName =
      typeof req.body?.customerName === "string"
        ? req.body.customerName.trim()
        : "";
    const quote =
      typeof req.body?.quote === "string" ? req.body.quote.trim() : "";

    if (!customerName) {
      throw new AppError("customerName is required", 400);
    }
    if (!quote) {
      throw new AppError("quote is required", 400);
    }

    const maxSortOrder = await prisma.testimonial.aggregate({
      _max: { sortOrder: true },
    });

    const testimonial = await prisma.testimonial.create({
      data: {
        customerName,
        quote,
        customerRole: normalizeOptionalString(req.body?.customerRole) ?? null,
        avatarUrl: normalizeOptionalString(req.body?.avatarUrl) ?? null,
        rating: normalizeOptionalRating(req.body?.rating) ?? null,
        isActive:
          typeof req.body?.isActive === "boolean" ? req.body.isActive : true,
        sortOrder: (maxSortOrder._max.sortOrder ?? -1) + 1,
      },
    });

    res.json(successResponse(testimonial, "Testimonial created"));
  }
);

//////////////////////////////////////////////////////
// ADMIN: UPDATE TESTIMONIAL
//////////////////////////////////////////////////////

export const updateTestimonial = catchAsync(
  async (req: Request, res: Response) => {
    const id = getTestimonialIdParam(req.params.id);

    const existing = await prisma.testimonial.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError("Testimonial not found", 404);
    }

    let customerName: string | undefined;
    if (req.body?.customerName !== undefined) {
      const trimmed =
        typeof req.body.customerName === "string"
          ? req.body.customerName.trim()
          : "";
      if (!trimmed) {
        throw new AppError("customerName is required", 400);
      }
      customerName = trimmed;
    }

    let quote: string | undefined;
    if (req.body?.quote !== undefined) {
      const trimmed =
        typeof req.body.quote === "string" ? req.body.quote.trim() : "";
      if (!trimmed) {
        throw new AppError("quote is required", 400);
      }
      quote = trimmed;
    }

    const testimonial = await prisma.testimonial.update({
      where: { id },
      data: {
        ...(customerName !== undefined ? { customerName } : {}),
        ...(quote !== undefined ? { quote } : {}),
        ...(req.body?.customerRole !== undefined
          ? {
              customerRole:
                normalizeOptionalString(req.body.customerRole) ?? null,
            }
          : {}),
        ...(req.body?.avatarUrl !== undefined
          ? { avatarUrl: normalizeOptionalString(req.body.avatarUrl) ?? null }
          : {}),
        ...(req.body?.rating !== undefined
          ? { rating: normalizeOptionalRating(req.body.rating) ?? null }
          : {}),
        ...(typeof req.body?.isActive === "boolean"
          ? { isActive: req.body.isActive }
          : {}),
      },
    });

    res.json(successResponse(testimonial, "Testimonial updated"));
  }
);

//////////////////////////////////////////////////////
// ADMIN: DELETE TESTIMONIAL
//////////////////////////////////////////////////////

export const deleteTestimonial = catchAsync(
  async (req: Request, res: Response) => {
    const id = getTestimonialIdParam(req.params.id);

    const existing = await prisma.testimonial.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError("Testimonial not found", 404);
    }

    await prisma.testimonial.delete({ where: { id } });

    res.json(successResponse(null, "Testimonial deleted"));
  }
);

//////////////////////////////////////////////////////
// ADMIN: REORDER TESTIMONIALS
//////////////////////////////////////////////////////

export const reorderTestimonials = catchAsync(
  async (req: Request, res: Response) => {
    const orderedIdsRaw = req.body?.orderedIds;

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

    const totalCount = await prisma.testimonial.count();
    if (totalCount !== orderedIds.length) {
      throw new AppError(
        "Reordering requires the full testimonial list",
        400
      );
    }

    const existing = await prisma.testimonial.findMany({
      where: { id: { in: orderedIds } },
      select: { id: true },
    });

    if (existing.length !== orderedIds.length) {
      throw new AppError("One or more testimonials could not be found", 404);
    }

    await prisma.$transaction(
      orderedIds.map((id: string, index: number) =>
        prisma.testimonial.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );

    const testimonials = await prisma.testimonial.findMany({
      orderBy: { sortOrder: "asc" },
    });

    res.json(successResponse(testimonials, "Testimonials reordered"));
  }
);
