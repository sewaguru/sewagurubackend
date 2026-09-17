import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { AuthRequest } from "../types/types";
import {
  buildCouponDraft,
  buildCouponListWhere,
  couponInclude,
  ensureCouponCodeAvailable,
  serializeCoupon,
  syncCouponServices,
  summarizeCoupons,
  toCouponCreateInput,
  toCouponUpdateInput,
  validateCouponForAmount,
} from "../services/coupon.service";

const getAssignedBranchIds = async (
  userId: string
) => {
  const adminBranches =
    await prisma.branchAdmin.findMany({
      where: { userId },
      select: { branchId: true },
    });

  return adminBranches.map(
    (row) => row.branchId
  );
};

const getCouponByIdOrThrow = async (
  id: string
) => {
  const coupon =
    await prisma.coupon.findUnique({
      where: { id },
      include: couponInclude,
    });

  if (!coupon) {
    throw new AppError(
      "Coupon not found",
      404
    );
  }

  return coupon;
};

const assertAssignedBranchAccess =
  async (
    userId: string,
    branchId: string
  ) => {
    const assignment =
      await prisma.branchAdmin.findFirst({
        where: {
          userId,
          branchId,
        },
        select: {
          branchId: true,
        },
      });

    if (!assignment) {
      throw new AppError(
        "Unauthorized branch access",
        403
      );
    }
  };

const assertBranchCouponServices = async (
  branchId: string,
  serviceNodeIds: string[]
) => {
  if (!serviceNodeIds.length) {
    return;
  }

  const enabledServices =
    await prisma.branchService.findMany({
      where: {
        branchId,
        serviceNodeId: {
          in: serviceNodeIds,
        },
        isActive: true,
      },
      select: {
        serviceNodeId: true,
      },
    });

  if (
    enabledServices.length !==
    serviceNodeIds.length
  ) {
    throw new AppError(
      "One or more selected services are not enabled for this branch",
      400
    );
  }
};

const toExistingDraft = (
  coupon: Awaited<
    ReturnType<
      typeof getCouponByIdOrThrow
    >
  >
) => ({
  code: coupon.code,
  title: coupon.title,
  description: coupon.description,
  badge: coupon.badge,
  meta: coupon.meta,
  imageUrl: coupon.imageUrl,
  isPublic: coupon.isPublic,
  autoApply: coupon.autoApply,
  firstBookingOnly: coupon.firstBookingOnly,
  minServiceCount: coupon.minServiceCount,
  branchId: coupon.branchId,
  discountType: coupon.discountType,
  value: coupon.value,
  maxDiscountAmount:
    coupon.maxDiscountAmount,
  minOrderAmount:
    coupon.minOrderAmount,
  startsAt: coupon.startsAt,
  expiresAt: coupon.expiresAt,
  isActive: coupon.isActive,
  serviceNodeIds:
    coupon.serviceTargets.map(
      (target) =>
        target.serviceNodeId
    ),
});

//////////////////////////////////////////////////////
// ADMIN: CREATE COUPON
//////////////////////////////////////////////////////

export const createCoupon = catchAsync(
  async (req: Request, res: Response) => {
    const draft =
      await buildCouponDraft(
        req.body as Record<
          string,
          unknown
        >
      );

    await ensureCouponCodeAvailable(
      draft.code
    );

    if (draft.branchId) {
      await assertBranchCouponServices(
        draft.branchId,
        draft.serviceNodeIds
      );
    }

    const coupon = await prisma.$transaction(
      async (tx) => {
        const created =
          await tx.coupon.create({
            data: toCouponCreateInput(
              draft
            ),
          });

        await syncCouponServices(
          tx,
          created.id,
          draft.serviceNodeIds
        );

        return tx.coupon.findUniqueOrThrow({
          where: { id: created.id },
          include: couponInclude,
        });
      }
    );

    res.json(
      successResponse(
        serializeCoupon(coupon),
        "Coupon created"
      )
    );
  }
);

//////////////////////////////////////////////////////
// ADMIN: UPDATE COUPON
//////////////////////////////////////////////////////

export const updateCoupon = catchAsync(
  async (req: Request, res: Response) => {
    const id = getParam(
      req.params.id,
      "couponId"
    );

    const existing =
      await getCouponByIdOrThrow(id);

    const draft =
      await buildCouponDraft(
        req.body as Record<
          string,
          unknown
        >,
        toExistingDraft(existing)
      );

    await ensureCouponCodeAvailable(
      draft.code,
      id
    );

    if (draft.branchId) {
      await assertBranchCouponServices(
        draft.branchId,
        draft.serviceNodeIds
      );
    }

    const coupon = await prisma.$transaction(
      async (tx) => {
        await tx.coupon.update({
          where: { id },
          data: toCouponUpdateInput(
            draft
          ),
        });

        await syncCouponServices(
          tx,
          id,
          draft.serviceNodeIds
        );

        return tx.coupon.findUniqueOrThrow({
          where: { id },
          include: couponInclude,
        });
      }
    );

    res.json(
      successResponse(
        serializeCoupon(coupon),
        "Coupon updated"
      )
    );
  }
);

//////////////////////////////////////////////////////
// ADMIN: LIST / DETAIL
//////////////////////////////////////////////////////

export const listCoupons = catchAsync(
  async (req: Request, res: Response) => {
    const coupons =
      await prisma.coupon.findMany({
        where: buildCouponListWhere(
          req.query as Record<
            string,
            string
          >
        ),
        include: couponInclude,
        orderBy: [
          {
            createdAt: "desc",
          },
          {
            code: "asc",
          },
        ],
      });

    res.json(
      successResponse(
        coupons.map(
          serializeCoupon
        ),
        "Coupons fetched",
        {
          summary:
            summarizeCoupons(
              coupons
            ),
        }
      )
    );
  }
);

export const getCouponById = catchAsync(
  async (req: Request, res: Response) => {
    const id = getParam(
      req.params.id,
      "couponId"
    );

    const coupon =
      await getCouponByIdOrThrow(id);

    res.json(
      successResponse(
        serializeCoupon(coupon)
      )
    );
  }
);

//////////////////////////////////////////////////////
// APP / DASHBOARD: VALIDATE COUPON
//////////////////////////////////////////////////////

export const validateCoupon = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const {
      code,
      amount,
      branchId,
      serviceNodeIds,
      serviceSubtotalById,
    } =
      req.body as {
        code: string;
        amount: number;
        branchId?: string;
        serviceNodeIds?: string[];
        serviceSubtotalById?: Record<
          string,
          number
        >;
      };

    if (!code) {
      throw new AppError(
        "Coupon code required",
        400
      );
    }

    if (
      typeof amount !== "number"
    ) {
      throw new AppError(
        "amount must be a number",
        400
      );
    }

    const { coupon, discount } =
      await validateCouponForAmount(
        code,
        amount,
        branchId,
        serviceNodeIds,
        serviceSubtotalById,
        req.user?.id,
        Array.isArray(serviceNodeIds)
          ? serviceNodeIds.length
          : serviceSubtotalById
            ? Object.keys(serviceSubtotalById).length
            : 0
      );

    res.json(
      successResponse(
        {
          coupon:
            serializeCoupon(
              coupon
            ),
          discount,
        },
        "Coupon valid"
      )
    );
  }
);

//////////////////////////////////////////////////////
// BRANCH ADMIN: BRANCH-SCOPED COUPONS
//////////////////////////////////////////////////////

export const listBranchCoupons =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const userId = req.user!.id;
      const branchIds =
        await getAssignedBranchIds(
          userId
        );

      if (!branchIds.length) {
        return res.json(
          successResponse(
            [],
            "No branches assigned",
            {
              summary: {
                total: 0,
                active: 0,
                scheduled: 0,
                expired: 0,
                inactive: 0,
                branchScoped: 0,
                global: 0,
              },
            }
          )
        );
      }

      const coupons =
        await prisma.coupon.findMany({
          where: buildCouponListWhere(
            req.query as Record<
              string,
              string
            >,
            branchIds
          ),
          include: couponInclude,
          orderBy: [
            {
              createdAt: "desc",
            },
            {
              code: "asc",
            },
          ],
        });

      res.json(
        successResponse(
          coupons.map(
            serializeCoupon
          ),
          "Branch coupons fetched",
          {
            summary:
              summarizeCoupons(
                coupons
              ),
          }
        )
      );
    }
  );

export const createBranchCoupon =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const userId = req.user!.id;
      const branchId =
        String(
          req.body.branchId ?? ""
        ).trim();

      if (!branchId) {
        throw new AppError(
          "branchId required",
          400
        );
      }

      await assertAssignedBranchAccess(
        userId,
        branchId
      );

      const draft =
        await buildCouponDraft({
          ...(req.body as Record<
            string,
            unknown
          >),
          branchId,
        });

      await ensureCouponCodeAvailable(
        draft.code
      );

      await assertBranchCouponServices(
        branchId,
        draft.serviceNodeIds
      );

      const coupon =
        await prisma.$transaction(
          async (tx) => {
            const created =
              await tx.coupon.create({
                data: toCouponCreateInput(
                  draft
                ),
              });

            await syncCouponServices(
              tx,
              created.id,
              draft.serviceNodeIds
            );

            return tx.coupon.findUniqueOrThrow({
              where: { id: created.id },
              include: couponInclude,
            });
          }
        );

      res.json(
        successResponse(
          serializeCoupon(coupon),
          "Branch coupon created"
        )
      );
    }
  );

export const updateBranchCoupon =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const userId = req.user!.id;
      const id = getParam(
        req.params.id,
        "couponId"
      );

      const existing =
        await getCouponByIdOrThrow(id);

      if (!existing.branchId) {
        throw new AppError(
          "Coupon not found",
          404
        );
      }

      await assertAssignedBranchAccess(
        userId,
        existing.branchId
      );

      const draft =
        await buildCouponDraft(
          {
            ...(req.body as Record<
              string,
              unknown
            >),
            branchId:
              existing.branchId,
          },
          toExistingDraft(existing)
        );

      await ensureCouponCodeAvailable(
        draft.code,
        id
      );

      await assertBranchCouponServices(
        existing.branchId,
        draft.serviceNodeIds
      );

      const coupon =
        await prisma.$transaction(
          async (tx) => {
            await tx.coupon.update({
              where: { id },
              data: toCouponUpdateInput(
                draft
              ),
            });

            await syncCouponServices(
              tx,
              id,
              draft.serviceNodeIds
            );

            return tx.coupon.findUniqueOrThrow({
              where: { id },
              include: couponInclude,
            });
          }
        );

      res.json(
        successResponse(
          serializeCoupon(coupon),
          "Branch coupon updated"
        )
      );
    }
  );
