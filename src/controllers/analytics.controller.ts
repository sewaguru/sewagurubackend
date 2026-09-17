import { Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { AuthRequest } from "../types/types";
import { PaymentStatus, Role } from "../generated/prisma";

type AnalyticsScope = "GLOBAL" | "BRANCH";

const parseDateParam = (
  value: unknown,
  fieldName: string
) => {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(
      `${fieldName} must be a valid date string`,
      400,
      "INVALID_DATE"
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      `${fieldName} must be a valid date string`,
      400,
      "INVALID_DATE"
    );
  }

  return parsed;
};

const getAssignedBranchIds = async (
  userId: string
) => {
  const assignments =
    await prisma.branchAdmin.findMany({
      where: { userId },
      select: { branchId: true },
    });

  return assignments.map(
    (assignment) => assignment.branchId
  );
};

export const getDashboardAnalytics = catchAsync(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError(
        "Unauthorized",
        401,
        "UNAUTHORIZED"
      );
    }

    const role = req.user.role as Role;

    const branchIdParam =
      typeof req.query.branchId === "string"
        ? req.query.branchId
        : undefined;

    const from = parseDateParam(
      req.query.from,
      "from"
    );
    const to = parseDateParam(req.query.to, "to");

    let scope: AnalyticsScope = "BRANCH";
    let allowedBranchIds: string[] | null = null;

    if (role === Role.SUPER_ADMIN) {
      if (branchIdParam) {
        allowedBranchIds = [branchIdParam];
        scope = "BRANCH";
      } else {
        allowedBranchIds = null;
        scope = "GLOBAL";
      }
    } else if (
      role === Role.ADMIN ||
      role === Role.BRANCH_ADMIN
    ) {
      const assignedBranchIds =
        await getAssignedBranchIds(req.user.id);

      if (!assignedBranchIds.length) {
        return res.json(
          successResponse(
            {
              scope: "BRANCH" as AnalyticsScope,
              branchId: null,
              range: {
                from: from?.toISOString() ?? null,
                to: to?.toISOString() ?? null,
              },
              totals: {
                bookings: 0,
                paidBookings: 0,
                subtotal: 0,
                tax: 0,
                discount: 0,
                total: 0,
                paidRevenue: 0,
              },
              breakdown: {
                byStatus: [],
                byPaymentStatus: [],
              },
              branches: [],
            },
            "No branches assigned"
          )
        );
      }

      if (branchIdParam) {
        if (!assignedBranchIds.includes(branchIdParam)) {
          throw new AppError(
            "Forbidden",
            403,
            "FORBIDDEN"
          );
        }
        allowedBranchIds = [branchIdParam];
      } else {
        allowedBranchIds = assignedBranchIds;
      }
      scope = "BRANCH";
    } else {
      throw new AppError(
        "Forbidden",
        403,
        "FORBIDDEN"
      );
    }

    const where: any = {
      ...(allowedBranchIds
        ? {
            branchId: {
              in: allowedBranchIds,
            },
          }
        : {}),
    };

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const paidWhere: any = {
      ...where,
      paymentStatus: PaymentStatus.PAID,
    };

    const [
      bookingsCount,
      paidBookingsCount,
      totalsAgg,
      paidAgg,
      byStatus,
      byPaymentStatus,
      branchesWithBookings,
      paidRevenueByBranch,
    ] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.count({ where: paidWhere }),
      prisma.booking.aggregate({
        where,
        _sum: {
          subtotal: true,
          taxAmount: true,
          discountAmount: true,
          totalAmount: true,
        },
      }),
      prisma.booking.aggregate({
        where: paidWhere,
        _sum: {
          totalAmount: true,
        },
      }),
      prisma.booking.groupBy({
        by: ["status"],
        where,
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),
      prisma.booking.groupBy({
        by: ["paymentStatus"],
        where,
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),
      prisma.booking.groupBy({
        by: ["branchId"],
        where,
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),
      prisma.booking.groupBy({
        by: ["branchId"],
        where: paidWhere,
        _sum: { totalAmount: true },
        orderBy: { _sum: { totalAmount: "desc" } },
      }),
    ]);

    const branchIds = Array.from(
      new Set([
        ...branchesWithBookings.map((b) => b.branchId),
        ...paidRevenueByBranch.map((b) => b.branchId),
      ])
    );

    const branches =
      branchIds.length === 0
        ? []
        : await prisma.branch.findMany({
            where: {
              id: { in: branchIds },
            },
            select: {
              id: true,
              name: true,
              city: {
                select: {
                  name: true,
                  state: true,
                },
              },
            },
          });

    const paidRevenueMap = new Map(
      paidRevenueByBranch.map((row) => [
        row.branchId,
        row._sum.totalAmount ?? 0,
      ])
    );

    const bookingCountMap = new Map(
      branchesWithBookings.map((row) => [
        row.branchId,
        row._count.id,
      ])
    );

    const branchRows = branches
      .map((b) => ({
        branchId: b.id,
        branchName: b.name,
        cityName: b.city?.name ?? null,
        state: b.city?.state ?? null,
        bookings: bookingCountMap.get(b.id) ?? 0,
        paidRevenue: paidRevenueMap.get(b.id) ?? 0,
      }))
      .sort((a, b) => b.paidRevenue - a.paidRevenue);

    res.json(
      successResponse({
        scope,
        branchId: branchIdParam ?? null,
        range: {
          from: from?.toISOString() ?? null,
          to: to?.toISOString() ?? null,
        },
        totals: {
          bookings: bookingsCount,
          paidBookings: paidBookingsCount,
          subtotal: totalsAgg._sum.subtotal ?? 0,
          tax: totalsAgg._sum.taxAmount ?? 0,
          discount: totalsAgg._sum.discountAmount ?? 0,
          total: totalsAgg._sum.totalAmount ?? 0,
          paidRevenue: paidAgg._sum.totalAmount ?? 0,
        },
        breakdown: {
          byStatus: byStatus.map((row) => ({
            status: row.status,
            count: row._count.id,
          })),
          byPaymentStatus: byPaymentStatus.map((row) => ({
            paymentStatus: row.paymentStatus,
            count: row._count.id,
          })),
        },
        branches: branchRows,
      })
    );
  }
);
