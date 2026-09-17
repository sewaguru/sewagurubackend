import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";
import { getParam } from "../utils/request.util";
import { AuthRequest } from "../types/types";
import { Prisma } from "../generated/prisma";
import {
  buildOfferDraft,
  buildOfferListWhere,
  offerInclude,
  serializeOffer,
  summarizeOffers,
  syncOfferServices,
  toOfferCreateInput,
  toOfferUpdateInput,
} from "../services/offer.service";

const getAssignedBranchIds = async (userId: string) => {
  const adminBranches = await prisma.branchAdmin.findMany({
    where: { userId },
    select: { branchId: true },
  });

  return adminBranches.map((row) => row.branchId);
};

const getOfferByIdOrThrow = async (id: string) => {
  const offer = await prisma.offer.findUnique({
    where: { id },
    include: offerInclude,
  });

  if (!offer) {
    throw new AppError("Offer not found", 404);
  }

  return offer;
};

const assertAssignedBranchAccess = async (
  userId: string,
  branchId: string
) => {
  const assignment = await prisma.branchAdmin.findFirst({
    where: {
      userId,
      branchId,
    },
    select: {
      branchId: true,
    },
  });

  if (!assignment) {
    throw new AppError("Unauthorized branch access", 403);
  }
};

const assertBranchOfferServices = async (
  branchId: string,
  serviceNodeIds: string[]
) => {
  if (!serviceNodeIds.length) {
    return;
  }

  const enabledServices = await prisma.branchService.findMany({
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

  if (enabledServices.length !== serviceNodeIds.length) {
    throw new AppError(
      "One or more selected services are not enabled for this branch",
      400
    );
  }
};

const toExistingDraft = (
  offer: Awaited<ReturnType<typeof getOfferByIdOrThrow>>
) => ({
  title: offer.title,
  description: offer.description,
  badge: offer.badge,
  meta: offer.meta,
  imageUrl: offer.imageUrl,
  branchId: offer.branchId,
  discountType: offer.discountType,
  value: offer.value,
  maxDiscountAmount: offer.maxDiscountAmount,
  minOrderAmount: offer.minOrderAmount,
  isPublic: offer.isPublic,
  autoApply: offer.autoApply,
  firstBookingOnly: offer.firstBookingOnly,
  minServiceCount: offer.minServiceCount,
  startsAt: offer.startsAt,
  expiresAt: offer.expiresAt,
  isActive: offer.isActive,
  serviceNodeIds: offer.serviceTargets.map((target) => target.serviceNodeId),
});

//////////////////////////////////////////////////////
// PUBLIC OFFERS (CUSTOMER APP)
//////////////////////////////////////////////////////

export const listPublicOffers = catchAsync(
  async (req: Request, res: Response) => {
    const { branchId } = req.query as {
      branchId?: string;
    };

    const now = new Date();

    const where: Prisma.OfferWhereInput = {
      isPublic: true,
      isActive: true,
      AND: [
        {
          OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        },
        {
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
      ],
    };

    if (branchId) {
      where.OR = [{ branchId }, { branchId: null }];
    } else {
      // Without an explicit branch, only show global offers.
      where.branchId = null;
    }

    const offers = await prisma.offer.findMany({
      where,
      include: offerInclude,
      orderBy: [{ createdAt: "desc" }],
      take: 30,
    });

    res.json(
      successResponse(
        offers.map(serializeOffer),
        "Offers fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// ADMIN: OFFERS MANAGEMENT
//////////////////////////////////////////////////////

export const listOffers = catchAsync(
  async (req: Request, res: Response) => {
    const offers = await prisma.offer.findMany({
      where: buildOfferListWhere(req.query as Record<string, string>),
      include: offerInclude,
      orderBy: [{ createdAt: "desc" }, { title: "asc" }],
    });

    res.json(
      successResponse(
        offers.map(serializeOffer),
        "Offers fetched",
        {
          summary: summarizeOffers(offers),
        }
      )
    );
  }
);

export const createOffer = catchAsync(
  async (req: Request, res: Response) => {
    const draft = await buildOfferDraft(req.body as Record<string, unknown>);

    if (draft.branchId) {
      await assertBranchOfferServices(draft.branchId, draft.serviceNodeIds);
    }

    const offer = await prisma.$transaction(async (tx) => {
      const created = await tx.offer.create({
        data: toOfferCreateInput(draft),
      });

      await syncOfferServices(tx, created.id, draft.serviceNodeIds);

      return tx.offer.findUniqueOrThrow({
        where: { id: created.id },
        include: offerInclude,
      });
    });

    res.json(successResponse(serializeOffer(offer), "Offer created"));
  }
);

export const getOfferById = catchAsync(
  async (req: Request, res: Response) => {
    const id = getParam(req.params.id, "offerId");
    const offer = await getOfferByIdOrThrow(id);
    res.json(successResponse(serializeOffer(offer), "Offer fetched"));
  }
);

export const updateOffer = catchAsync(
  async (req: Request, res: Response) => {
    const id = getParam(req.params.id, "offerId");

    const existing = await getOfferByIdOrThrow(id);

    const draft = await buildOfferDraft(
      req.body as Record<string, unknown>,
      toExistingDraft(existing)
    );

    if (draft.branchId) {
      await assertBranchOfferServices(draft.branchId, draft.serviceNodeIds);
    }

    const offer = await prisma.$transaction(async (tx) => {
      await tx.offer.update({
        where: { id },
        data: toOfferUpdateInput(draft),
      });

      await syncOfferServices(tx, id, draft.serviceNodeIds);

      return tx.offer.findUniqueOrThrow({
        where: { id },
        include: offerInclude,
      });
    });

    res.json(successResponse(serializeOffer(offer), "Offer updated"));
  }
);

//////////////////////////////////////////////////////
// BRANCH ADMIN: BRANCH-SCOPED OFFERS
//////////////////////////////////////////////////////

export const listBranchOffers = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const branchIds = await getAssignedBranchIds(userId);

    if (!branchIds.length) {
      return res.json(
        successResponse([], "No branches assigned", {
          summary: {
            total: 0,
            active: 0,
            scheduled: 0,
            expired: 0,
            inactive: 0,
            branchScoped: 0,
            global: 0,
          },
        })
      );
    }

    const offers = await prisma.offer.findMany({
      where: buildOfferListWhere(req.query as Record<string, string>, branchIds),
      include: offerInclude,
      orderBy: [{ createdAt: "desc" }, { title: "asc" }],
    });

    res.json(
      successResponse(offers.map(serializeOffer), "Branch offers fetched", {
        summary: summarizeOffers(offers),
      })
    );
  }
);

export const createBranchOffer = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const branchId = String(req.body.branchId ?? "").trim();

    if (!branchId) {
      throw new AppError("branchId required", 400);
    }

    await assertAssignedBranchAccess(userId, branchId);

    const draft = await buildOfferDraft(
      {
        ...(req.body as Record<string, unknown>),
        branchId,
      },
      undefined
    );

    if (!draft.branchId) {
      throw new AppError("branchId required", 400);
    }

    await assertBranchOfferServices(draft.branchId, draft.serviceNodeIds);

    const offer = await prisma.$transaction(async (tx) => {
      const created = await tx.offer.create({
        data: toOfferCreateInput(draft),
      });

      await syncOfferServices(tx, created.id, draft.serviceNodeIds);

      return tx.offer.findUniqueOrThrow({
        where: { id: created.id },
        include: offerInclude,
      });
    });

    res.json(successResponse(serializeOffer(offer), "Branch offer created"));
  }
);

export const updateBranchOffer = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const id = getParam(req.params.id, "offerId");

    const existing = await getOfferByIdOrThrow(id);

    if (!existing.branchId) {
      throw new AppError("Offer is not branch-scoped", 400);
    }

    await assertAssignedBranchAccess(userId, existing.branchId);

    const draft = await buildOfferDraft(
      req.body as Record<string, unknown>,
      toExistingDraft(existing)
    );

    if (!draft.branchId) {
      throw new AppError("branchId required", 400);
    }

    await assertBranchOfferServices(draft.branchId, draft.serviceNodeIds);

    const offer = await prisma.$transaction(async (tx) => {
      await tx.offer.update({
        where: { id },
        data: toOfferUpdateInput(draft),
      });

      await syncOfferServices(tx, id, draft.serviceNodeIds);

      return tx.offer.findUniqueOrThrow({
        where: { id },
        include: offerInclude,
      });
    });

    res.json(successResponse(serializeOffer(offer), "Branch offer updated"));
  }
);
