import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { OfferDiscountType, Prisma } from "../generated/prisma";

export const offerInclude = {
  branch: {
    select: {
      id: true,
      name: true,
      city: {
        select: {
          id: true,
          name: true,
          state: true,
        },
      },
    },
  },
  _count: {
    select: {
      bookings: true,
    },
  },
  serviceTargets: {
    select: {
      serviceNodeId: true,
      serviceNode: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  },
} satisfies Prisma.OfferInclude;

export type OfferRecord = Prisma.OfferGetPayload<{
  include: typeof offerInclude;
}>;

export type OfferLifecycleStatus =
  | "ACTIVE"
  | "SCHEDULED"
  | "EXPIRED"
  | "INACTIVE";

export type OfferScope = "GLOBAL" | "BRANCH";

export interface OfferListFilters {
  search?: string;
  scope?: string;
  branchId?: string;
  serviceNodeId?: string;
  isActive?: string;
  status?: string;
}

type OfferDraft = {
  title: string;
  description: string | null;
  badge: string | null;
  meta: string | null;
  imageUrl: string | null;
  branchId: string | null;
  discountType: OfferDiscountType;
  value: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number | null;
  isPublic: boolean;
  autoApply: boolean;
  firstBookingOnly: boolean;
  minServiceCount: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  serviceNodeIds: string[];
};

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const parseOptionalNumber = (
  value: unknown,
  field: string
) => {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError(
      `${field} must be a valid number`,
      400
    );
  }

  return parsed;
};

const parseOptionalInteger = (
  value: unknown,
  field: string
) => {
  const parsed = parseOptionalNumber(
    value,
    field
  );

  if (parsed == null) {
    return null;
  }

  if (!Number.isInteger(parsed)) {
    throw new AppError(
      `${field} must be an integer`,
      400
    );
  }

  return parsed;
};

const parseOptionalDate = (
  value: unknown,
  field: string
) => {
  if (value == null || value === "") {
    return null;
  }

  const parsed = new Date(String(value));

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      `${field} must be a valid date`,
      400
    );
  }

  return parsed;
};

const parseBooleanFilter = (
  value: string | undefined
) => {
  if (value == null || value === "") {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new AppError(
    "isActive filter must be true or false",
    400
  );
};

const parseInputBoolean = (
  value: unknown,
  field: string
) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }

  throw new AppError(
    `${field} must be true or false`,
    400
  );
};

export const getOfferScope = (offer: {
  branchId: string | null;
}): OfferScope => (offer.branchId ? "BRANCH" : "GLOBAL");

export const getOfferLifecycleStatus = (offer: {
  isActive: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
}): OfferLifecycleStatus => {
  if (!offer.isActive) {
    return "INACTIVE";
  }

  const now = new Date();

  if (offer.startsAt && offer.startsAt > now) {
    return "SCHEDULED";
  }

  if (offer.expiresAt && offer.expiresAt < now) {
    return "EXPIRED";
  }

  return "ACTIVE";
};

export const serializeOffer = (offer: OfferRecord) => ({
  id: offer.id,
  title: offer.title,
  description: offer.description,
  badge: offer.badge,
  meta: offer.meta,
  imageUrl: offer.imageUrl,
  branchId: offer.branchId,
  branch: offer.branch,
  discountType: offer.discountType,
  value: offer.value,
  maxDiscountAmount: offer.maxDiscountAmount,
  minOrderAmount: offer.minOrderAmount,
  isPublic: offer.isPublic,
  autoApply: offer.autoApply,
  firstBookingOnly: offer.firstBookingOnly,
  minServiceCount: offer.minServiceCount,
  isActive: offer.isActive,
  startsAt: offer.startsAt,
  expiresAt: offer.expiresAt,
  createdAt: offer.createdAt,
  updatedAt: offer.updatedAt,
  usageCount: offer._count.bookings,
  scope: getOfferScope(offer),
  status: getOfferLifecycleStatus(offer),
  applicableServiceIds: offer.serviceTargets.map(
    (target) => target.serviceNodeId
  ),
  applicableServices: offer.serviceTargets
    .map((target) => target.serviceNode)
    .filter(Boolean),
  appliesToAllServices: offer.serviceTargets.length === 0,
});

export const buildOfferListWhere = (
  filters: OfferListFilters,
  allowedBranchIds?: string[]
): Prisma.OfferWhereInput => {
  const where: Prisma.OfferWhereInput = {};
  const search = filters.search?.trim();

  if (search) {
    where.OR = [
      {
        title: {
          contains: search,
          mode: Prisma.QueryMode.insensitive,
        },
      },
      {
        description: {
          contains: search,
          mode: Prisma.QueryMode.insensitive,
        },
      },
    ];
  }

  if (filters.scope === "GLOBAL") {
    where.branchId = null;
  }

  if (filters.scope === "BRANCH") {
    where.branchId = filters.branchId ? filters.branchId : { not: null };
  }

  if (
    filters.scope !== "GLOBAL" &&
    filters.scope !== "BRANCH" &&
    filters.branchId
  ) {
    where.branchId = filters.branchId;
  }

  if (filters.serviceNodeId) {
    where.serviceTargets = {
      some: {
        serviceNodeId: filters.serviceNodeId,
      },
    };
  }

  const parsedIsActive =
    parseBooleanFilter(filters.isActive);

  if (typeof parsedIsActive === "boolean") {
    where.isActive = parsedIsActive;
  }

  const status = filters.status?.toUpperCase();
  const now = new Date();

  if (status === "ACTIVE") {
    where.isActive = true;
    where.AND = [
      {
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      },
      {
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
    ];
  }

  if (status === "SCHEDULED") {
    where.isActive = true;
    where.startsAt = { gt: now };
  }

  if (status === "EXPIRED") {
    where.isActive = true;
    where.expiresAt = { lt: now };
  }

  if (status === "INACTIVE") {
    where.isActive = false;
  }

  if (allowedBranchIds) {
    const existingAnd =
      where.AND == null
        ? []
        : Array.isArray(where.AND)
          ? where.AND
          : [where.AND];

    where.AND = [
      ...existingAnd,
      {
        branchId: {
          in: allowedBranchIds,
        },
      },
    ];
  }

  return where;
};

export const summarizeOffers = (offers: OfferRecord[]) => {
  const summary = {
    total: offers.length,
    active: 0,
    scheduled: 0,
    expired: 0,
    inactive: 0,
    branchScoped: 0,
    global: 0,
  };

  for (const offer of offers) {
    const status =
      getOfferLifecycleStatus(offer);
    const scope = getOfferScope(offer);

    if (status === "ACTIVE") summary.active += 1;
    if (status === "SCHEDULED") summary.scheduled += 1;
    if (status === "EXPIRED") summary.expired += 1;
    if (status === "INACTIVE") summary.inactive += 1;

    if (scope === "BRANCH") {
      summary.branchScoped += 1;
    } else {
      summary.global += 1;
    }
  }

  return summary;
};

const parseServiceNodeIds = (value: unknown) => {
  if (value == null || value === "") {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(
      "serviceNodeIds must be an array of service IDs",
      400
    );
  }

  const ids = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  return Array.from(new Set(ids));
};

const ensureServiceNodesExist = async (serviceNodeIds: string[]) => {
  if (!serviceNodeIds.length) {
    return;
  }

  const services = await prisma.serviceNode.findMany({
    where: {
      id: { in: serviceNodeIds },
      isActive: true,
    },
    select: {
      id: true,
      isBookable: true,
    },
  });

  if (services.length !== serviceNodeIds.length) {
    throw new AppError("One or more selected services are invalid", 400);
  }

  const nonBookable = services.some((service) => !service.isBookable);

  if (nonBookable) {
    throw new AppError("Offers can target only bookable services or variants", 400);
  }
};

const ensureBranchExists = async (branchId: string | null) => {
  if (!branchId) {
    return;
  }

  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });

  if (!branch) {
    throw new AppError("Selected branch not found", 400);
  }
};

export const buildOfferDraft = async (
  payload: Record<string, unknown>,
  existing?: OfferDraft
): Promise<OfferDraft> => {
  const title = hasOwn(payload, "title")
    ? String(payload.title ?? "").trim()
    : existing?.title;

  if (!title) {
    throw new AppError("title is required", 400);
  }

  const rawDiscountType = hasOwn(payload, "discountType")
    ? String(payload.discountType ?? "")
        .trim()
        .toUpperCase()
    : existing?.discountType;

  if (
    rawDiscountType !== OfferDiscountType.PERCENT &&
    rawDiscountType !== OfferDiscountType.FLAT
  ) {
    throw new AppError("Invalid discountType", 400);
  }

  const rawValue = hasOwn(payload, "value")
    ? parseOptionalNumber(payload.value, "value")
    : existing?.value;

  if (rawValue == null) {
    throw new AppError("value is required", 400);
  }

  if (rawValue <= 0) {
    throw new AppError("value must be greater than zero", 400);
  }

  if (
    rawDiscountType === OfferDiscountType.PERCENT &&
    rawValue > 100
  ) {
    throw new AppError("Percent discount cannot exceed 100", 400);
  }

  const minOrderAmount = hasOwn(payload, "minOrderAmount")
    ? parseOptionalNumber(payload.minOrderAmount, "minOrderAmount")
    : existing?.minOrderAmount ?? null;

  if (minOrderAmount != null && minOrderAmount < 0) {
    throw new AppError("minOrderAmount cannot be negative", 400);
  }

  const maxDiscountAmount = hasOwn(payload, "maxDiscountAmount")
    ? parseOptionalNumber(payload.maxDiscountAmount, "maxDiscountAmount")
    : existing?.maxDiscountAmount ?? null;

  if (maxDiscountAmount != null && maxDiscountAmount <= 0) {
    throw new AppError("maxDiscountAmount must be greater than zero", 400);
  }

  const startsAt = hasOwn(payload, "startsAt")
    ? parseOptionalDate(payload.startsAt, "startsAt")
    : existing?.startsAt ?? null;

  const expiresAt = hasOwn(payload, "expiresAt")
    ? parseOptionalDate(payload.expiresAt, "expiresAt")
    : existing?.expiresAt ?? null;

  if (startsAt && expiresAt && expiresAt <= startsAt) {
    throw new AppError("expiresAt must be after startsAt", 400);
  }

  const description = hasOwn(payload, "description")
    ? String(payload.description ?? "").trim() || null
    : existing?.description ?? null;

  const badge = hasOwn(payload, "badge")
    ? String(payload.badge ?? "").trim() || null
    : existing?.badge ?? null;

  const meta = hasOwn(payload, "meta")
    ? String(payload.meta ?? "").trim() || null
    : existing?.meta ?? null;

  const imageUrl = hasOwn(payload, "imageUrl")
    ? String(payload.imageUrl ?? "").trim() || null
    : existing?.imageUrl ?? null;

  const branchId = hasOwn(payload, "branchId")
    ? String(payload.branchId ?? "").trim() || null
    : existing?.branchId ?? null;

  const isPublic = hasOwn(payload, "isPublic")
    ? parseInputBoolean(payload.isPublic, "isPublic")
    : existing?.isPublic ?? true;

  const autoApply = hasOwn(payload, "autoApply")
    ? parseInputBoolean(payload.autoApply, "autoApply")
    : existing?.autoApply ?? false;

  const firstBookingOnly = hasOwn(payload, "firstBookingOnly")
    ? parseInputBoolean(payload.firstBookingOnly, "firstBookingOnly")
    : existing?.firstBookingOnly ?? false;

  const minServiceCount = hasOwn(payload, "minServiceCount")
    ? parseOptionalInteger(payload.minServiceCount, "minServiceCount")
    : existing?.minServiceCount ?? null;

  if (minServiceCount != null && minServiceCount < 1) {
    throw new AppError("minServiceCount must be at least 1", 400);
  }

  const isActive = hasOwn(payload, "isActive")
    ? parseInputBoolean(payload.isActive, "isActive")
    : existing?.isActive ?? true;

  await ensureBranchExists(branchId);

  const serviceNodeIds = hasOwn(payload, "serviceNodeIds")
    ? parseServiceNodeIds(payload.serviceNodeIds)
    : hasOwn(payload, "applicableServiceIds")
      ? parseServiceNodeIds(payload.applicableServiceIds)
      : existing?.serviceNodeIds ?? [];

  await ensureServiceNodesExist(serviceNodeIds);

  return {
    title,
    description,
    badge,
    meta,
    imageUrl,
    branchId,
    discountType: rawDiscountType,
    value: rawValue,
    maxDiscountAmount:
      rawDiscountType === OfferDiscountType.PERCENT ? maxDiscountAmount : null,
    minOrderAmount,
    isPublic,
    autoApply,
    firstBookingOnly,
    minServiceCount,
    startsAt,
    expiresAt,
    isActive,
    serviceNodeIds,
  };
};

export const toOfferCreateInput = (
  draft: OfferDraft
): Prisma.OfferUncheckedCreateInput => ({
  title: draft.title,
  description: draft.description,
  badge: draft.badge,
  meta: draft.meta,
  imageUrl: draft.imageUrl,
  branchId: draft.branchId,
  discountType: draft.discountType,
  value: draft.value,
  maxDiscountAmount: draft.maxDiscountAmount,
  minOrderAmount: draft.minOrderAmount,
  isPublic: draft.isPublic,
  autoApply: draft.autoApply,
  firstBookingOnly: draft.firstBookingOnly,
  minServiceCount: draft.minServiceCount,
  startsAt: draft.startsAt,
  expiresAt: draft.expiresAt,
  isActive: draft.isActive,
});

export const toOfferUpdateInput = (
  draft: OfferDraft
): Prisma.OfferUncheckedUpdateInput => ({
  title: draft.title,
  description: draft.description,
  badge: draft.badge,
  meta: draft.meta,
  imageUrl: draft.imageUrl,
  branchId: draft.branchId,
  discountType: draft.discountType,
  value: draft.value,
  maxDiscountAmount: draft.maxDiscountAmount,
  minOrderAmount: draft.minOrderAmount,
  isPublic: draft.isPublic,
  autoApply: draft.autoApply,
  firstBookingOnly: draft.firstBookingOnly,
  minServiceCount: draft.minServiceCount,
  startsAt: draft.startsAt,
  expiresAt: draft.expiresAt,
  isActive: draft.isActive,
});

export const syncOfferServices = async (
  tx: Prisma.TransactionClient,
  offerId: string,
  serviceNodeIds: string[]
) => {
  await tx.offerService.deleteMany({
    where: { offerId },
  });

  if (!serviceNodeIds.length) {
    return;
  }

  await tx.offerService.createMany({
    data: serviceNodeIds.map((serviceNodeId) => ({
      offerId,
      serviceNodeId,
    })),
    skipDuplicates: true,
  });
};

type OfferValidationContext = {
  branchId?: string;
  serviceNodeIds?: string[];
  serviceSubtotalById?: Record<string, number>;
  userId?: string;
  serviceCount?: number;
};

const resolveServiceCount = (
  context: OfferValidationContext
) => {
  if (typeof context.serviceCount === "number") {
    return context.serviceCount;
  }

  if (context.serviceNodeIds) {
    return context.serviceNodeIds.length;
  }

  if (context.serviceSubtotalById) {
    return Object.keys(context.serviceSubtotalById).length;
  }

  return 0;
};

const validateOfferRecordForAmount = async (
  offer: OfferRecord,
  amount: number,
  context: OfferValidationContext
) => {
  if (!offer.isActive) {
    throw new AppError("Offer is not active", 400);
  }

  if (
    offer.branchId &&
    context.branchId &&
    offer.branchId !== context.branchId
  ) {
    throw new AppError(
      "Offer is not valid for this branch",
      400
    );
  }

  const now = new Date();

  if (offer.startsAt && offer.startsAt > now) {
    throw new AppError("Offer is not yet active", 400);
  }

  if (offer.expiresAt && offer.expiresAt < now) {
    throw new AppError("Offer has expired", 400);
  }

  if (offer.firstBookingOnly) {
    if (!context.userId) {
      throw new AppError(
        "Offer is only valid for first booking",
        400
      );
    }

    const existingBookings =
      await prisma.booking.count({
        where: {
          userId: context.userId,
        },
      });

    if (existingBookings > 0) {
      throw new AppError(
        "Offer is only valid for first booking",
        400
      );
    }
  }

  if (offer.minServiceCount != null) {
    const count = resolveServiceCount(context);

    if (count < offer.minServiceCount) {
      throw new AppError(
        `Add at least ${offer.minServiceCount} services to use this offer`,
        400
      );
    }
  }

  const targetedServiceIds =
    offer.serviceTargets.map((target) => target.serviceNodeId);

  const hasServiceTargeting = targetedServiceIds.length > 0;

  const minOrder = offer.minOrderAmount ?? 0;

  const selectedServiceIds =
    context.serviceNodeIds ??
    Object.keys(context.serviceSubtotalById ?? {});

  const applicableServiceIds = hasServiceTargeting
    ? selectedServiceIds.filter((id) => targetedServiceIds.includes(id))
    : selectedServiceIds;

  if (hasServiceTargeting && applicableServiceIds.length === 0) {
    throw new AppError(
      "Offer is not valid for selected services",
      400
    );
  }

  const applicableAmount =
    context.serviceSubtotalById &&
    Object.keys(context.serviceSubtotalById).length > 0
      ? applicableServiceIds.reduce(
          (sum, serviceId) =>
            sum +
            (context.serviceSubtotalById?.[serviceId] ?? 0),
          0
        )
      : amount;

  if (applicableAmount <= 0) {
    throw new AppError(
      "Offer does not apply to selected services",
      400
    );
  }

  if (applicableAmount < minOrder) {
    throw new AppError(
      `Order amount must be at least ${minOrder} to use this offer`,
      400
    );
  }

  let discount = 0;

  if (offer.discountType === OfferDiscountType.PERCENT) {
    discount = (applicableAmount * offer.value) / 100;

    if (offer.maxDiscountAmount != null) {
      discount = Math.min(discount, offer.maxDiscountAmount);
    }
  } else {
    discount = offer.value;
  }

  discount = Math.min(discount, applicableAmount, amount);

  if (discount <= 0) {
    throw new AppError(
      "Offer does not apply to this amount",
      400
    );
  }

  return discount;
};

export const findBestAutoApplyOfferForAmount = async (
  amount: number,
  branchId: string,
  serviceNodeIds: string[],
  serviceSubtotalById: Record<string, number>,
  userId: string,
  serviceCount: number
) => {
  if (amount <= 0) {
    return null;
  }

  const now = new Date();

  const offers = await prisma.offer.findMany({
    where: {
      autoApply: true,
      isActive: true,
      OR: [{ branchId }, { branchId: null }],
      AND: [
        {
          OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        },
        {
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
      ],
    },
    include: offerInclude,
    orderBy: [{ createdAt: "desc" }],
    take: 50,
  });

  let best: { offer: OfferRecord; discount: number } | null = null;

  for (const offer of offers) {
    try {
      const discount =
        await validateOfferRecordForAmount(offer, amount, {
          branchId,
          serviceNodeIds,
          serviceSubtotalById,
          userId,
          serviceCount,
        });

      if (!best || discount > best.discount) {
        best = { offer, discount };
      }
    } catch {
      // ignore offers that don't apply
    }
  }

  return best;
};

