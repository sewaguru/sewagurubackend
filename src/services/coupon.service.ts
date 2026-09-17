import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import {
  CouponDiscountType,
  Prisma,
} from "../generated/prisma";

export const couponInclude = {
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
} satisfies Prisma.CouponInclude;

export type CouponRecord = Prisma.CouponGetPayload<{
  include: typeof couponInclude;
}>;

export type CouponLifecycleStatus =
  | "ACTIVE"
  | "SCHEDULED"
  | "EXPIRED"
  | "INACTIVE";

export type CouponScope = "GLOBAL" | "BRANCH";

export interface CouponListFilters {
  search?: string;
  scope?: string;
  branchId?: string;
  serviceNodeId?: string;
  isActive?: string;
  status?: string;
}

type CouponDraft = {
  code: string;
  title: string | null;
  description: string | null;
  badge: string | null;
  meta: string | null;
  imageUrl: string | null;
  isPublic: boolean;
  autoApply: boolean;
  firstBookingOnly: boolean;
  minServiceCount: number | null;
  branchId: string | null;
  discountType: CouponDiscountType;
  value: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number | null;
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
  if (
    value == null ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError(`${field} must be a valid number`, 400);
  }

  return parsed;
};

const parseOptionalDate = (
  value: unknown,
  field: string
) => {
  if (
    value == null ||
    value === ""
  ) {
    return null;
  }

  const parsed = new Date(String(value));

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`${field} must be a valid date`, 400);
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

const parseBoolean = (
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

  throw new AppError("isActive filter must be true or false", 400);
};

const parseInputBoolean = (
  value: unknown,
  field: string
) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }
  }

  throw new AppError(`${field} must be true or false`, 400);
};

export const normalizeCouponCode = (
  code: string
) => code.trim().toUpperCase();

export const getCouponScope = (
  coupon: {
    branchId: string | null;
  }
): CouponScope =>
  coupon.branchId ? "BRANCH" : "GLOBAL";

export const getCouponLifecycleStatus = (
  coupon: {
    isActive: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
  }
): CouponLifecycleStatus => {
  if (!coupon.isActive) {
    return "INACTIVE";
  }

  const now = new Date();

  if (
    coupon.startsAt &&
    coupon.startsAt > now
  ) {
    return "SCHEDULED";
  }

  if (
    coupon.expiresAt &&
    coupon.expiresAt < now
  ) {
    return "EXPIRED";
  }

  return "ACTIVE";
};

export const serializeCoupon = (
  coupon: CouponRecord
) => ({
  id: coupon.id,
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
  branch: coupon.branch,
  discountType: coupon.discountType,
  value: coupon.value,
  maxDiscountAmount: coupon.maxDiscountAmount,
  minOrderAmount: coupon.minOrderAmount,
  isActive: coupon.isActive,
  startsAt: coupon.startsAt,
  expiresAt: coupon.expiresAt,
  createdAt: coupon.createdAt,
  updatedAt: coupon.updatedAt,
  usageCount: coupon._count.bookings,
  scope: getCouponScope(coupon),
  status: getCouponLifecycleStatus(coupon),
  applicableServiceIds: coupon.serviceTargets.map(
    (target) => target.serviceNodeId
  ),
  applicableServices: coupon.serviceTargets
    .map((target) => target.serviceNode)
    .filter(Boolean),
  appliesToAllServices:
    coupon.serviceTargets.length === 0,
});

export const buildCouponListWhere = (
  filters: CouponListFilters,
  allowedBranchIds?: string[]
): Prisma.CouponWhereInput => {
  const where: Prisma.CouponWhereInput = {};
  const search = filters.search?.trim();

  if (search) {
    where.OR = [
      {
        code: {
          contains: search,
          mode: Prisma.QueryMode.insensitive,
        },
      },
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
    where.branchId = filters.branchId
      ? filters.branchId
      : { not: null };
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
    parseBoolean(filters.isActive);

  if (typeof parsedIsActive === "boolean") {
    where.isActive = parsedIsActive;
  }

  const status = filters.status?.toUpperCase();
  const now = new Date();

  if (status === "ACTIVE") {
    where.isActive = true;
    where.AND = [
      {
        OR: [
          { startsAt: null },
          { startsAt: { lte: now } },
        ],
      },
      {
        OR: [
          { expiresAt: null },
          { expiresAt: { gte: now } },
        ],
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

export const summarizeCoupons = (
  coupons: CouponRecord[]
) => {
  const summary = {
    total: coupons.length,
    active: 0,
    scheduled: 0,
    expired: 0,
    inactive: 0,
    branchScoped: 0,
    global: 0,
  };

  for (const coupon of coupons) {
    const status =
      getCouponLifecycleStatus(coupon);
    const scope =
      getCouponScope(coupon);

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

const parseServiceNodeIds = (
  value: unknown
) => {
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
    .map((entry) =>
      typeof entry === "string"
        ? entry.trim()
        : ""
    )
    .filter(Boolean);

  return Array.from(new Set(ids));
};

const ensureServiceNodesExist = async (
  serviceNodeIds: string[]
) => {
  if (!serviceNodeIds.length) {
    return;
  }

  const services =
    await prisma.serviceNode.findMany({
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
    throw new AppError(
      "One or more selected services are invalid",
      400
    );
  }

  const nonBookable = services.some(
    (service) => !service.isBookable
  );

  if (nonBookable) {
    throw new AppError(
      "Coupons can target only bookable services or variants",
      400
    );
  }
};

const ensureBranchExists = async (
  branchId: string | null
) => {
  if (!branchId) {
    return;
  }

  const branch =
    await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    });

  if (!branch) {
    throw new AppError("Selected branch not found", 400);
  }
};

export const ensureCouponCodeAvailable =
  async (
    code: string,
    excludeId?: string
  ) => {
    const existing =
      await prisma.coupon.findFirst({
        where: {
          code: {
            equals: code,
            mode: Prisma.QueryMode.insensitive,
          },
          ...(excludeId
            ? {
                NOT: {
                  id: excludeId,
                },
              }
            : {}),
        },
        select: {
          id: true,
        },
      });

    if (existing) {
      throw new AppError(
        "Coupon code already exists",
        409
      );
    }
  };

export const buildCouponDraft = async (
  payload: Record<string, unknown>,
  existing?: CouponDraft
): Promise<CouponDraft> => {
  const resolvedCode = hasOwn(payload, "code")
    ? normalizeCouponCode(
        String(payload.code ?? "")
      )
    : existing?.code;

  if (!resolvedCode) {
    throw new AppError("code is required", 400);
  }

  const rawDiscountType = hasOwn(
    payload,
    "discountType"
  )
    ? String(payload.discountType ?? "")
        .trim()
        .toUpperCase()
    : existing?.discountType;

  if (
    rawDiscountType !== CouponDiscountType.PERCENT &&
    rawDiscountType !== CouponDiscountType.FLAT
  ) {
    throw new AppError("Invalid discountType", 400);
  }

  const rawValue = hasOwn(payload, "value")
    ? parseOptionalNumber(
        payload.value,
        "value"
      )
    : existing?.value;

  if (rawValue == null) {
    throw new AppError("value is required", 400);
  }

  if (rawValue <= 0) {
    throw new AppError(
      "value must be greater than zero",
      400
    );
  }

  if (
    rawDiscountType === CouponDiscountType.PERCENT &&
    rawValue > 100
  ) {
    throw new AppError(
      "Percent discount cannot exceed 100",
      400
    );
  }

  const minOrderAmount = hasOwn(
    payload,
    "minOrderAmount"
  )
    ? parseOptionalNumber(
        payload.minOrderAmount,
        "minOrderAmount"
      )
    : existing?.minOrderAmount ?? null;

  if (
    minOrderAmount != null &&
    minOrderAmount < 0
  ) {
    throw new AppError(
      "minOrderAmount cannot be negative",
      400
    );
  }

  const maxDiscountAmount = hasOwn(
    payload,
    "maxDiscountAmount"
  )
    ? parseOptionalNumber(
        payload.maxDiscountAmount,
        "maxDiscountAmount"
      )
    : existing?.maxDiscountAmount ?? null;

  if (
    maxDiscountAmount != null &&
    maxDiscountAmount <= 0
  ) {
    throw new AppError(
      "maxDiscountAmount must be greater than zero",
      400
    );
  }

  const startsAt = hasOwn(
    payload,
    "startsAt"
  )
    ? parseOptionalDate(
        payload.startsAt,
        "startsAt"
      )
    : existing?.startsAt ?? null;

  const expiresAt = hasOwn(
    payload,
    "expiresAt"
  )
    ? parseOptionalDate(
        payload.expiresAt,
        "expiresAt"
      )
    : existing?.expiresAt ?? null;

  if (
    startsAt &&
    expiresAt &&
    expiresAt <= startsAt
  ) {
    throw new AppError(
      "expiresAt must be after startsAt",
      400
    );
  }

  const description = hasOwn(
    payload,
    "description"
  )
    ? String(payload.description ?? "").trim() ||
      null
    : existing?.description ?? null;

  const title = hasOwn(payload, "title")
    ? String(payload.title ?? "")
        .trim() || null
    : existing?.title ?? null;

  const badge = hasOwn(payload, "badge")
    ? String(payload.badge ?? "")
        .trim() || null
    : existing?.badge ?? null;

  const meta = hasOwn(payload, "meta")
    ? String(payload.meta ?? "")
        .trim() || null
    : existing?.meta ?? null;

  const imageUrl = hasOwn(
    payload,
    "imageUrl"
  )
    ? String(payload.imageUrl ?? "")
        .trim() || null
    : existing?.imageUrl ?? null;

  const isPublic = hasOwn(
    payload,
    "isPublic"
  )
    ? parseInputBoolean(
        payload.isPublic,
        "isPublic"
      )
    : existing?.isPublic ?? true;

  const autoApply = hasOwn(
    payload,
    "autoApply"
  )
    ? parseInputBoolean(
        payload.autoApply,
        "autoApply"
      )
    : existing?.autoApply ?? false;

  const firstBookingOnly = hasOwn(
    payload,
    "firstBookingOnly"
  )
    ? parseInputBoolean(
        payload.firstBookingOnly,
        "firstBookingOnly"
      )
    : existing?.firstBookingOnly ?? false;

  const minServiceCount = hasOwn(
    payload,
    "minServiceCount"
  )
    ? parseOptionalInteger(
        payload.minServiceCount,
        "minServiceCount"
      )
    : existing?.minServiceCount ??
      null;

  if (
    minServiceCount != null &&
    minServiceCount < 1
  ) {
    throw new AppError(
      "minServiceCount must be at least 1",
      400
    );
  }

  const branchId = hasOwn(payload, "branchId")
    ? String(payload.branchId ?? "").trim() ||
      null
    : existing?.branchId ?? null;

  const isActive = hasOwn(
    payload,
    "isActive"
  )
    ? parseInputBoolean(
        payload.isActive,
        "isActive"
      )
    : existing?.isActive ?? true;

  await ensureBranchExists(branchId);

  const serviceNodeIds = hasOwn(
    payload,
    "serviceNodeIds"
  )
    ? parseServiceNodeIds(
        payload.serviceNodeIds
      )
    : hasOwn(payload, "applicableServiceIds")
      ? parseServiceNodeIds(
          payload.applicableServiceIds
        )
      : existing?.serviceNodeIds ?? [];

  await ensureServiceNodesExist(
    serviceNodeIds
  );

  return {
    code: resolvedCode,
    title,
    description,
    badge,
    meta,
    imageUrl,
    isPublic,
    autoApply,
    firstBookingOnly,
    minServiceCount,
    branchId,
    discountType: rawDiscountType,
    value: rawValue,
    maxDiscountAmount:
      rawDiscountType === CouponDiscountType.PERCENT
        ? maxDiscountAmount
        : null,
    minOrderAmount,
    startsAt,
    expiresAt,
    isActive,
    serviceNodeIds,
  };
};

export const toCouponCreateInput = (
  draft: CouponDraft
): Prisma.CouponUncheckedCreateInput => ({
  code: draft.code,
  title: draft.title,
  description: draft.description,
  badge: draft.badge,
  meta: draft.meta,
  imageUrl: draft.imageUrl,
  isPublic: draft.isPublic,
  autoApply: draft.autoApply,
  firstBookingOnly: draft.firstBookingOnly,
  minServiceCount: draft.minServiceCount,
  branchId: draft.branchId,
  discountType: draft.discountType,
  value: draft.value,
  maxDiscountAmount:
    draft.maxDiscountAmount,
  minOrderAmount:
    draft.minOrderAmount,
  startsAt: draft.startsAt,
  expiresAt: draft.expiresAt,
  isActive: draft.isActive,
});

export const toCouponUpdateInput = (
  draft: CouponDraft
): Prisma.CouponUncheckedUpdateInput => ({
  code: draft.code,
  title: draft.title,
  description: draft.description,
  badge: draft.badge,
  meta: draft.meta,
  imageUrl: draft.imageUrl,
  isPublic: draft.isPublic,
  autoApply: draft.autoApply,
  firstBookingOnly: draft.firstBookingOnly,
  minServiceCount: draft.minServiceCount,
  branchId: draft.branchId,
  discountType: draft.discountType,
  value: draft.value,
  maxDiscountAmount:
    draft.maxDiscountAmount,
  minOrderAmount:
    draft.minOrderAmount,
  startsAt: draft.startsAt,
  expiresAt: draft.expiresAt,
  isActive: draft.isActive,
});

export const syncCouponServices = async (
  tx: Prisma.TransactionClient,
  couponId: string,
  serviceNodeIds: string[]
) => {
  await tx.couponService.deleteMany({
    where: { couponId },
  });

  if (!serviceNodeIds.length) {
    return;
  }

  await tx.couponService.createMany({
    data: serviceNodeIds.map(
      (serviceNodeId) => ({
        couponId,
        serviceNodeId,
      })
    ),
    skipDuplicates: true,
  });
};

export const findCouponByCode = async (
  code: string
) => {
  const trimmedCode =
    normalizeCouponCode(code);

  if (!trimmedCode) {
    throw new AppError("Coupon code required", 400);
  }

  return prisma.coupon.findFirst({
    where: {
      code: {
        equals: trimmedCode,
        mode: Prisma.QueryMode.insensitive,
      },
    },
    include: couponInclude,
  });
};

type CouponValidationContext = {
  branchId?: string;
  serviceNodeIds?: string[];
  serviceSubtotalById?: Record<string, number>;
  userId?: string;
  serviceCount?: number;
};

const resolveServiceCount = (
  context: CouponValidationContext
) => {
  if (
    typeof context.serviceCount ===
    "number"
  ) {
    return context.serviceCount;
  }

  if (context.serviceNodeIds) {
    return context.serviceNodeIds.length;
  }

  if (context.serviceSubtotalById) {
    return Object.keys(
      context.serviceSubtotalById
    ).length;
  }

  return 0;
};

const validateCouponRecordForAmount =
  async (
    coupon: CouponRecord,
    amount: number,
    context: CouponValidationContext
  ) => {
    if (!coupon.isActive) {
      throw new AppError(
        "Invalid or inactive coupon",
        400
      );
    }

    if (
      coupon.branchId &&
      context.branchId &&
      coupon.branchId !== context.branchId
    ) {
      throw new AppError(
        "Coupon is not valid for this branch",
        400
      );
    }

    const now = new Date();

    if (
      coupon.startsAt &&
      coupon.startsAt > now
    ) {
      throw new AppError(
        "Coupon is not yet active",
        400
      );
    }

    if (
      coupon.expiresAt &&
      coupon.expiresAt < now
    ) {
      throw new AppError(
        "Coupon has expired",
        400
      );
    }

    if (coupon.firstBookingOnly) {
      if (!context.userId) {
        throw new AppError(
          "Coupon is only valid for first booking",
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
          "Coupon is only valid for first booking",
          400
        );
      }
    }

    if (
      coupon.minServiceCount != null
    ) {
      const count =
        resolveServiceCount(context);

      if (count < coupon.minServiceCount) {
        throw new AppError(
          `Add at least ${coupon.minServiceCount} services to use this offer`,
          400
        );
      }
    }

    const targetedServiceIds =
      coupon.serviceTargets.map(
        (target) => target.serviceNodeId
      );

    const hasServiceTargeting =
      targetedServiceIds.length > 0;

    const minOrder =
      coupon.minOrderAmount ?? 0;

    const selectedServiceIds =
      context.serviceNodeIds ??
      Object.keys(
        context.serviceSubtotalById ?? {}
      );

    const applicableServiceIds =
      hasServiceTargeting
        ? selectedServiceIds.filter((id) =>
            targetedServiceIds.includes(id)
          )
        : selectedServiceIds;

    if (
      hasServiceTargeting &&
      applicableServiceIds.length === 0
    ) {
      throw new AppError(
        "Coupon is not valid for selected services",
        400
      );
    }

    const applicableAmount =
      context.serviceSubtotalById &&
      Object.keys(context.serviceSubtotalById)
        .length > 0
        ? applicableServiceIds.reduce(
            (sum, serviceId) =>
              sum +
              (context.serviceSubtotalById?.[
                serviceId
              ] ?? 0),
            0
          )
        : amount;

    if (applicableAmount <= 0) {
      throw new AppError(
        "Coupon does not apply to selected services",
        400
      );
    }

    if (applicableAmount < minOrder) {
      throw new AppError(
        `Order amount must be at least ${minOrder} to use this coupon`,
        400
      );
    }

    let discount = 0;

    if (
      coupon.discountType ===
      CouponDiscountType.PERCENT
    ) {
      discount =
        (applicableAmount *
          coupon.value) /
        100;

      if (
        coupon.maxDiscountAmount != null
      ) {
        discount = Math.min(
          discount,
          coupon.maxDiscountAmount
        );
      }
    } else {
      discount = coupon.value;
    }

    discount = Math.min(
      discount,
      applicableAmount,
      amount
    );

    if (discount <= 0) {
      throw new AppError(
        "Coupon does not apply to this amount",
        400
      );
    }

    return discount;
  };

export const validateCouponForAmount =
  async (
    code: string,
    amount: number,
    branchId?: string,
    serviceNodeIds?: string[],
    serviceSubtotalById?: Record<string, number>,
    userId?: string,
    serviceCount?: number
  ) => {
    if (amount <= 0) {
      throw new AppError(
        "Amount must be greater than zero",
        400
      );
    }

    const coupon =
      await findCouponByCode(code);

    if (!coupon) {
      throw new AppError(
        "Invalid or inactive coupon",
        400
      );
    }

    const context: CouponValidationContext = {};

    if (branchId !== undefined) {
      context.branchId = branchId;
    }

    if (serviceNodeIds !== undefined) {
      context.serviceNodeIds = serviceNodeIds;
    }

    if (serviceSubtotalById !== undefined) {
      context.serviceSubtotalById = serviceSubtotalById;
    }

    if (userId !== undefined) {
      context.userId = userId;
    }

    if (serviceCount !== undefined) {
      context.serviceCount = serviceCount;
    }

    const discount =
      await validateCouponRecordForAmount(
        coupon,
        amount,
        context
      );

    return {
      coupon,
      discount,
    };
  };

export const findBestAutoApplyCouponForAmount =
  async (
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

    const coupons =
      await prisma.coupon.findMany({
        where: {
          autoApply: true,
          isActive: true,
          OR: [
            { branchId },
            { branchId: null },
          ],
          AND: [
            {
              OR: [
                { startsAt: null },
                { startsAt: { lte: now } },
              ],
            },
            {
              OR: [
                { expiresAt: null },
                { expiresAt: { gte: now } },
              ],
            },
          ],
        },
        include: couponInclude,
        orderBy: [
          { createdAt: "desc" },
          { code: "asc" },
        ],
        take: 50,
      });

    let best: {
      coupon: CouponRecord;
      discount: number;
    } | null = null;

    for (const coupon of coupons) {
      try {
        const discount =
          await validateCouponRecordForAmount(
            coupon,
            amount,
            {
              branchId,
              serviceNodeIds,
              serviceSubtotalById,
              userId,
              serviceCount,
            }
          );

        if (
          !best ||
          discount > best.discount
        ) {
          best = { coupon, discount };
        }
      } catch {
        // Ignore coupons that do not apply
      }
    }

    return best;
  };
