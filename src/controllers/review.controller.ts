import { Request, Response } from "express";
import { BookingStatus } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { AuthRequest } from "../types/types";
import { AppError } from "../utils/AppError";
import { catchAsync } from "../utils/catchAsync";
import { getParam } from "../utils/request.util";
import { successResponse } from "../utils/response.util";
import { getServiceNodeView } from "../utils/bookingSnapshot";
import { refreshProfessionalRating } from "../services/professionalStats.service";

const assertAuthenticatedUser = (req: AuthRequest) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }

  return req.user;
};

const normalizeRating = (value: unknown) => {
  const rating = Number(value);

  if (
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5
  ) {
    throw new AppError(
      "rating must be an integer between 1 and 5",
      400,
      "INVALID_RATING"
    );
  }

  return rating;
};

const normalizeComment = (value: unknown) => {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(
      "comment must be a string",
      400,
      "INVALID_COMMENT"
    );
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length > 500) {
    throw new AppError(
      "comment cannot exceed 500 characters",
      400,
      "COMMENT_TOO_LONG"
    );
  }

  return trimmed;
};

export const createReviewForBookingItem =
  catchAsync(async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const bookingItemId = getParam(
      req.params.bookingItemId,
      "bookingItemId"
    );

    const { rating, comment } = req.body as {
      rating?: unknown;
      comment?: unknown;
    };

    const normalizedRating = normalizeRating(rating);
    const normalizedComment = normalizeComment(comment);

    const bookingItem =
      await prisma.bookingItem.findUnique({
        where: { id: bookingItemId },
        include: {
          booking: {
            select: {
              id: true,
              userId: true,
              status: true,
              assignedProfessionalId: true,
            },
          },
          serviceNode: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          review: {
            select: {
              id: true,
            },
          },
        },
      });

    if (!bookingItem) {
      throw new AppError(
        "Booking item not found",
        404,
        "BOOKING_ITEM_NOT_FOUND"
      );
    }

    if (bookingItem.booking.userId !== authUser.id) {
      throw new AppError(
        "Forbidden",
        403,
        "FORBIDDEN"
      );
    }

    if (
      bookingItem.booking.status !==
      BookingStatus.COMPLETED
    ) {
      throw new AppError(
        "You can submit a review only after the service is completed",
        400,
        "BOOKING_NOT_COMPLETED"
      );
    }

    if (bookingItem.review) {
      throw new AppError(
        "Review already submitted for this service",
        409,
        "REVIEW_ALREADY_EXISTS"
      );
    }

    if (!bookingItem.serviceNodeId) {
      throw new AppError(
        "This service is no longer available for review.",
        410,
        "SERVICE_REMOVED"
      );
    }

    const review = await prisma.serviceReview.create({
      data: {
        bookingId: bookingItem.bookingId,
        bookingItemId: bookingItem.id,
        userId: authUser.id,
        serviceNodeId: bookingItem.serviceNodeId,
        // Snapshot who actually performed the work at review time.
        professionalId: bookingItem.booking.assignedProfessionalId,
        rating: normalizedRating,
        comment: normalizedComment,
      },
      include: {
        serviceNode: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    if (review.professionalId) {
      try {
        await refreshProfessionalRating(review.professionalId);
      } catch (error) {
        console.error(
          "[REVIEW] Failed to refresh professional rating",
          { professionalId: review.professionalId, error }
        );
      }
    }

    res.json(
      successResponse(review, "Review submitted")
    );
  });

export const getMyBookingReviewContext =
  catchAsync(async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const bookingId = getParam(
      req.params.bookingId,
      "bookingId"
    );

    const booking = await prisma.booking.findFirst({
      where: {
        id: bookingId,
        userId: authUser.id,
      },
      select: {
        id: true,
        status: true,
        items: {
          select: {
            id: true,
            quantity: true,
            price: true,
            serviceSnapshot: true,
            serviceNode: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
            review: {
              select: {
                id: true,
                rating: true,
                comment: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!booking) {
      throw new AppError(
        "Booking not found",
        404,
        "BOOKING_NOT_FOUND"
      );
    }

    const isCompleted =
      booking.status === BookingStatus.COMPLETED;

    const items = booking.items.map((item) => {
      const hasReview = Boolean(item.review);
      const canReview = isCompleted && !hasReview;

      return {
        bookingItemId: item.id,
        quantity: item.quantity,
        price: item.price,
        serviceNode: getServiceNodeView({
          serviceNode: item.serviceNode,
          serviceSnapshot:
            item.serviceSnapshot,
          fallbackId:
            item.serviceNode?.id ??
            null,
        }),
        review: item.review ?? null,
        canReview,
        reviewBlockedReason: canReview
          ? null
          : hasReview
            ? "Review already submitted"
            : "Review available after service completion",
      };
    });

    const pendingCount = items.filter(
      (item) => item.canReview
    ).length;

    res.json(
      successResponse(
        {
          bookingId: booking.id,
          bookingStatus: booking.status,
          isCompleted,
          items,
          pendingCount,
        },
        "Booking review status fetched"
      )
    );
  });

export const getServiceReviewsBySlug =
  catchAsync(async (req: Request, res: Response) => {
    const slug = getParam(req.params.slug, "slug");
    const rawPage = Number(req.query.page ?? 1);
    const rawPageSize = Number(
      req.query.pageSize ?? 10
    );

    const page = Number.isFinite(rawPage) && rawPage > 0
      ? Math.floor(rawPage)
      : 1;
    const pageSize =
      Number.isFinite(rawPageSize) &&
      rawPageSize > 0
        ? Math.min(Math.floor(rawPageSize), 50)
        : 10;

    const service =
      await prisma.serviceNode.findFirst({
        where: {
          slug,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      });

    if (!service) {
      throw new AppError(
        "Service not found",
        404,
        "SERVICE_NOT_FOUND"
      );
    }

    const where = {
      serviceNodeId: service.id,
      isVisible: true,
    };

    const [total, aggregate, ratingGroups, reviews] =
      await Promise.all([
        prisma.serviceReview.count({ where }),
        prisma.serviceReview.aggregate({
          where,
          _avg: {
            rating: true,
          },
        }),
        prisma.serviceReview.groupBy({
          by: ["rating"],
          where,
          _count: {
            _all: true,
          },
        }),
        prisma.serviceReview.findMany({
          where,
          orderBy: {
            createdAt: "desc",
          },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            rating: true,
            comment: true,
            createdAt: true,
            user: {
              select: {
                profile: {
                  select: {
                    fullName: true,
                  },
                },
              },
            },
          },
        }),
      ]);

    const breakdown = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };

    for (const group of ratingGroups) {
      breakdown[group.rating as 1 | 2 | 3 | 4 | 5] =
        group._count._all;
    }

    res.json(
      successResponse(
        {
          service,
          summary: {
            averageRating:
              aggregate._avg.rating ?? 0,
            totalReviews: total,
            breakdown,
          },
          reviews: reviews.map((review) => ({
            id: review.id,
            rating: review.rating,
            comment: review.comment,
            createdAt: review.createdAt,
            reviewerName:
              review.user.profile
                ?.fullName ?? "Customer",
          })),
        },
        "Service reviews fetched",
        {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        }
      )
    );
  });
