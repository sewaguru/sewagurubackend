import { Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { AuthRequest } from "../types/types";
import {
  BookingStatus,
  PaymentStatus,
  NotificationType,
  Prisma,
} from "../generated/prisma";
import { createBookingDisplayId } from "../utils/bookingDisplayId";
import {
  buildAddressSnapshot,
  buildBranchSnapshot,
  buildCartSnapshot,
  buildServiceSnapshot,
  getBookingCancellationCutoffMinutes,
  getBookingItemNames,
  getServiceNodeView,
  hydrateBookingForResponse,
} from "../utils/bookingSnapshot";
import { computeTaxAmount } from "../utils/tax.util";
import {
  validateCouponForAmount,
} from "../services/coupon.service";
import { findBestAutoApplyOfferForAmount } from "../services/offer.service";
import { uploadToS3 } from "../services/s3.service";
import {
  createNotification,
  notifyBranchAdmins,
} from "../services/notification.service";
import { dispatchBookingPlacedSideEffects } from "../services/bookingPlacement.service";
import { validateBranchScheduledAt } from "../services/branchBookingSchedule.service";
import {
  getInitialBookingStatus,
  getInitialPaymentStatus,
  getPlatformPaymentSettings,
} from "../services/platformSettings.service";
import {
  moveBookingToTrash,
} from "../services/trash.service";
import { sendBookingCompletionEmail } from "../services/emailManagement.service";
import {
  syncBookingPaymentStateIfNeeded,
  syncBookingPaymentsIfNeeded,
} from "../services/paymentSync.service";
import {
  BookingData,
  computeServiceLinePricing,
  toBookingData,
  toPositiveQuantity,
} from "../utils/servicePricing.util";
import { getAssignedBranchIds } from "../utils/branchScope.util";
import { calculateDistanceKm } from "../utils/geo.util";
import { cancelDispatchForBooking } from "../services/dispatch.service";
import { ensureEarningForBooking } from "../services/earnings.service";
import { recordJobOutcome } from "../services/professionalStats.service";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const assertAuthenticatedUser = (req: AuthRequest) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401);
  }
  return req.user;
};

const SERVICE_NOT_AVAILABLE_MESSAGE =
  "This service is not available in the selected branch.";
const ADDRESS_OUTSIDE_SERVICE_RADIUS_MESSAGE =
  "Service is not available at the selected place for this branch.";
const MAX_BRANCH_SERVICE_RADIUS_KM = 20;
const SINGLE_SERVICE_MESSAGE =
  "This service must be booked individually.";
const INCOMPATIBLE_COMBINATION_MESSAGE =
  "This service must be booked individually and cannot be combined with other services.";


const assertAddressWithinBranchRadius = ({
  branch,
  address,
}: {
  branch: {
    latitude: number;
    longitude: number;
    serviceRadiusKm: number;
  };
  address: {
    latitude: number;
    longitude: number;
  };
}) => {
  const maxRadiusKm = Math.min(
    MAX_BRANCH_SERVICE_RADIUS_KM,
    Math.max(0, branch.serviceRadiusKm)
  );
  const distanceKm = calculateDistanceKm(
    {
      latitude: branch.latitude,
      longitude: branch.longitude,
    },
    {
      latitude: address.latitude,
      longitude: address.longitude,
    }
  );

  if (distanceKm > maxRadiusKm) {
    throw new AppError(
      `${ADDRESS_OUTSIDE_SERVICE_RADIUS_MESSAGE} Distance: ${distanceKm.toFixed(
        1
      )} km, max: ${maxRadiusKm} km.`,
      400,
      "ADDRESS_OUTSIDE_SERVICE_RADIUS"
    );
  }
};

type BookingListView =
  | "all"
  | "today"
  | "upcoming"
  | "overdue"
  | "completed"
  | "cancelled"
  | "payment_pending";

type BookingDateField =
  | "createdAt"
  | "scheduledAt";

type DashboardBookingFilters = {
  status?: BookingStatus;
  paymentStatus?: PaymentStatus;
  branchId?: string;
  userId?: string;
  search?: string;
  dateField?: BookingDateField;
  from?: string;
  to?: string;
  view?: BookingListView;
  page?: string;
  pageSize?: string;
};

const ACTIVE_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.CREATED,
  BookingStatus.PENDING,
  BookingStatus.BOOKED,
  BookingStatus.CONFIRMED,
  BookingStatus.TECHNICIAN_ASSIGNED,
  BookingStatus.TECHNICIAN_EN_ROUTE,
  BookingStatus.TECHNICIAN_ARRIVED,
  BookingStatus.VISIT_SCHEDULED,
  BookingStatus.INSPECTION_COMPLETED,
  BookingStatus.QUOTE_SENT,
  BookingStatus.QUOTE_APPROVED,
  BookingStatus.IN_PROGRESS,
  BookingStatus.WORK_IN_PROGRESS,
];

const parseFilterDate = (
  rawValue?: string,
  endOfDay = false
) => {
  if (
    typeof rawValue !== "string" ||
    rawValue.trim().length === 0
  ) {
    return null;
  }

  const trimmed = rawValue.trim();
  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      `Invalid date value: ${trimmed}`,
      400
    );
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (endOfDay) {
      parsed.setHours(23, 59, 59, 999);
    } else {
      parsed.setHours(0, 0, 0, 0);
    }
  }

  return parsed;
};

const buildDashboardBookingSearchWhere = (
  rawSearch?: string
): Prisma.BookingWhereInput | null => {
  const search =
    typeof rawSearch === "string"
      ? rawSearch.trim()
      : "";

  if (!search) {
    return null;
  }

  return {
    OR: [
      {
        displayId: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        branch: {
          name: {
            contains: search,
            mode: "insensitive",
          },
        },
      },
      {
        user: {
          profile: {
            fullName: {
              contains: search,
              mode: "insensitive",
            },
          },
        },
      },
      {
        user: {
          authMethods: {
            some: {
              identifier: {
                contains: search,
                mode: "insensitive",
              },
            },
          },
        },
      },
    ],
  };
};

const deriveBookingUserContact = (
  user:
    | {
        profile?: {
          email?: string | null;
        } | null;
        authMethods?: Array<{
          identifier?: string | null;
          identifierType?: string | null;
          isPrimary?: boolean | null;
          isVerified?: boolean | null;
          createdAt?: Date | null;
        }>;
        [key: string]: unknown;
      }
    | null
    | undefined
) => {
  if (!user) {
    return {
      phone: null,
      email: null,
    };
  }

  const authMethods = Array.isArray(
    user.authMethods
  )
    ? user.authMethods
    : [];

  const findIdentifier = (
    type: "PHONE" | "EMAIL"
  ) =>
    authMethods.find(
      (method) =>
        method.identifierType ===
          type &&
        method.isPrimary
    )?.identifier ||
    authMethods.find(
      (method) =>
        method.identifierType ===
          type &&
        method.isVerified
    )?.identifier ||
    authMethods.find(
      (method) =>
        method.identifierType === type
    )?.identifier ||
    null;

  return {
    phone: findIdentifier(
      "PHONE"
    ),
    email:
      user.profile?.email?.trim() ||
      findIdentifier("EMAIL"),
  };
};

const withBookingUserContact = <
  T extends Record<
    string,
    unknown
  >,
>(
  booking: T
) => {
  const user =
    "user" in booking
      ? booking.user
      : null;

  if (
    !user ||
    typeof user !== "object"
  ) {
    return booking;
  }

  const derived =
    deriveBookingUserContact(
      user as {
        profile?: {
          email?: string | null;
        } | null;
        authMethods?: Array<{
          identifier?: string | null;
          identifierType?: string | null;
          isPrimary?: boolean | null;
          isVerified?: boolean | null;
        }>;
      }
    );

  const {
    authMethods: _authMethods,
    ...safeUser
  } = user as Record<
    string,
    unknown
  >;

  return {
    ...booking,
    user: {
      ...safeUser,
      phone: derived.phone,
      email: derived.email,
    },
  };
};

const buildDashboardBookingScopeWhere = ({
  visibilityWhere,
  branchId,
  userId,
  search,
  dateField,
  from,
  to,
  activeOnly = true,
}: {
  visibilityWhere?: Prisma.BookingWhereInput | undefined;
  branchId?: string | undefined;
  userId?: string | undefined;
  search?: string | undefined;
  dateField?: BookingDateField | undefined;
  from?: string | undefined;
  to?: string | undefined;
  activeOnly?: boolean | undefined;
}): Prisma.BookingWhereInput => {
  const where: Prisma.BookingWhereInput = {
    ...(activeOnly
      ? { isActive: true }
      : { deletedAt: null }),
    ...(visibilityWhere ?? {}),
    ...(branchId ? { branchId } : {}),
    ...(userId ? { userId } : {}),
  };

  const searchWhere =
    buildDashboardBookingSearchWhere(search);

  if (searchWhere) {
    where.AND = [
      ...(Array.isArray(where.AND)
        ? where.AND
        : []),
      searchWhere,
    ];
  }

  const rangeField: BookingDateField =
    dateField === "scheduledAt"
      ? "scheduledAt"
      : "createdAt";

  const fromDate = parseFilterDate(from);
  const toDate =
    parseFilterDate(to, true);

  if (fromDate || toDate) {
    where[rangeField] = {
      ...(fromDate
        ? { gte: fromDate }
        : {}),
      ...(toDate
        ? { lte: toDate }
        : {}),
    };
  }

  return where;
};

const combineBookingWhere = (
  ...conditions: Array<
    Prisma.BookingWhereInput | null | undefined
  >
): Prisma.BookingWhereInput => {
  const validConditions: Prisma.BookingWhereInput[] =
    [];

  for (const condition of conditions) {
    if (
      condition &&
      Object.keys(condition).length > 0
    ) {
      validConditions.push(condition);
    }
  }

  if (validConditions.length === 0) {
    return {};
  }

  if (validConditions.length === 1) {
    return validConditions[0]!;
  }

  return {
    AND: validConditions,
  };
};

const applyDashboardBookingView = (
  baseWhere: Prisma.BookingWhereInput,
  {
    view,
    status,
    paymentStatus,
  }: {
    view?: BookingListView | undefined;
    status?: BookingStatus | undefined;
    paymentStatus?: PaymentStatus | undefined;
  }
): Prisma.BookingWhereInput => {
  const constraints: Prisma.BookingWhereInput[] =
    [
      baseWhere,
      ...(status ? [{ status }] : []),
      ...(paymentStatus
        ? [{ paymentStatus }]
        : []),
    ];

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(
    23,
    59,
    59,
    999
  );

  switch (view) {
    case "today":
      constraints.push({
        scheduledAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      });
      break;
    case "upcoming":
      constraints.push({
        scheduledAt: {
          gte: now,
        },
      });
      constraints.push({
        status: {
          in: ACTIVE_BOOKING_STATUSES,
        },
      });
      break;
    case "overdue":
      constraints.push({
        scheduledAt: {
          lt: now,
        },
      });
      constraints.push({
        status: {
          in: ACTIVE_BOOKING_STATUSES,
        },
      });
      break;
    case "completed":
      constraints.push({
        status: BookingStatus.COMPLETED,
      });
      break;
    case "cancelled":
      constraints.push({
        status: BookingStatus.CANCELLED,
      });
      break;
    case "payment_pending":
      constraints.push({
        paymentStatus: paymentStatus
          ? paymentStatus
          : {
            in: [
              PaymentStatus.PENDING,
              PaymentStatus.FAILED,
            ],
          },
      });
      break;
    case "all":
    default:
      break;
  }

  return combineBookingWhere(
    ...constraints
  );
};

const bookingListInclude = {
  items: {
    include: {
      serviceNode: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  },
  branch: {
    include: {
      city: true,
    },
  },
  user: {
    include: {
      profile: true,
      authMethods: {
        select: {
          identifier: true,
          identifierType: true,
          isPrimary: true,
          isVerified: true,
          createdAt: true,
        },
        orderBy: [
          { isPrimary: "desc" },
          { isVerified: "desc" },
          { createdAt: "asc" },
        ],
      },
    },
  },
} satisfies Prisma.BookingInclude;

const getDashboardBookingSummary = async (
  scopeWhere: Prisma.BookingWhereInput
) => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(
    23,
    59,
    59,
    999
  );

  const [
    total,
    scheduledToday,
    upcoming,
    overdue,
    completed,
    cancelled,
    paymentPending,
  ] = await Promise.all([
    prisma.booking.count({
      where: scopeWhere,
    }),
    prisma.booking.count({
      where: combineBookingWhere(
        scopeWhere,
        {
        scheduledAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
        }
      ),
    }),
    prisma.booking.count({
      where: combineBookingWhere(
        scopeWhere,
        {
        scheduledAt: { gte: now },
        status: {
          in: ACTIVE_BOOKING_STATUSES,
        },
        }
      ),
    }),
    prisma.booking.count({
      where: combineBookingWhere(
        scopeWhere,
        {
        scheduledAt: { lt: now },
        status: {
          in: ACTIVE_BOOKING_STATUSES,
        },
        }
      ),
    }),
    prisma.booking.count({
      where: combineBookingWhere(
        scopeWhere,
        {
        status: BookingStatus.COMPLETED,
        }
      ),
    }),
    prisma.booking.count({
      where: combineBookingWhere(
        scopeWhere,
        {
        status: BookingStatus.CANCELLED,
        }
      ),
    }),
    prisma.booking.count({
      where: combineBookingWhere(
        scopeWhere,
        {
        paymentStatus: {
          in: [
            PaymentStatus.PENDING,
            PaymentStatus.FAILED,
          ],
        },
        }
      ),
    }),
  ]);

  return {
    total,
    scheduledToday,
    upcoming,
    overdue,
    completed,
    cancelled,
    paymentPending,
  };
};

const getDashboardPaymentSummary = async (
  scopeWhere: Prisma.BookingWhereInput
) => {
  const [
    paidAggregate,
    pendingAggregate,
    failedAggregate,
    refundedAggregate,
    notRequiredCount,
  ] = await Promise.all([
    prisma.booking.aggregate({
      where: combineBookingWhere(
        scopeWhere,
        {
          paymentStatus: PaymentStatus.PAID,
        }
      ),
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.booking.aggregate({
      where: combineBookingWhere(
        scopeWhere,
        {
          paymentStatus:
            PaymentStatus.PENDING,
        }
      ),
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.booking.aggregate({
      where: combineBookingWhere(
        scopeWhere,
        {
          paymentStatus:
            PaymentStatus.FAILED,
        }
      ),
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.booking.aggregate({
      where: combineBookingWhere(
        scopeWhere,
        {
          paymentStatus:
            PaymentStatus.REFUNDED,
        }
      ),
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.booking.count({
      where: combineBookingWhere(
        scopeWhere,
        {
          paymentStatus:
            PaymentStatus.NOT_REQUIRED,
        }
      ),
    }),
  ]);

  return {
    paidCount:
      paidAggregate._count._all,
    paidAmount:
      paidAggregate._sum.totalAmount ??
      0,
    pendingCount:
      pendingAggregate._count._all,
    pendingAmount:
      pendingAggregate._sum
        .totalAmount ?? 0,
    failedCount:
      failedAggregate._count._all,
    failedAmount:
      failedAggregate._sum.totalAmount ??
      0,
    refundedCount:
      refundedAggregate._count._all,
    refundedAmount:
      refundedAggregate._sum
        .totalAmount ?? 0,
    notRequiredCount,
  };
};

type BookingUploadFieldDefinition = {
  key: string;
  label: string;
};

type BookingUploadMedia = {
  id: string;
  url: string;
  fileName: string;
};

const toUploadFieldDefinitions = (
  bookingFields: unknown
): BookingUploadFieldDefinition[] => {
  if (!Array.isArray(bookingFields)) {
    return [];
  }

  return bookingFields
    .map((field) => {
      if (
        typeof field !== "object" ||
        field === null
      ) {
        return null;
      }

      const type =
        typeof (field as any).type === "string"
          ? String((field as any).type)
          : "";

      if (type !== "image_upload") {
        return null;
      }

      const key =
        typeof (field as any).key === "string"
          ? String((field as any).key).trim()
          : "";

      const label =
        typeof (field as any).label === "string"
          ? String((field as any).label).trim()
          : key;

      if (!key) {
        return null;
      }

      return { key, label };
    })
    .filter(
      (
        field
      ): field is BookingUploadFieldDefinition =>
        field !== null
    );
};

const toStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" &&
            item.trim().length > 0
        )
        .map((item) => item.trim())
    : [];

const toRecord = (
  value: unknown
): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as Record<string, unknown>;
};

const assertBookingModeCompatibility = (
  items: Array<{
    serviceNodeId: string;
    bookingMode?: string | null;
    quantity: number;
  }>
) => {
  const byServiceId = new Map<
    string,
    {
      bookingMode?: string | null;
      quantity: number;
    }
  >();

  for (const item of items) {
    const previous = byServiceId.get(
      item.serviceNodeId
    );

    byServiceId.set(item.serviceNodeId, {
      bookingMode:
        item.bookingMode ??
        previous?.bookingMode ??
        null,
      quantity:
        (previous?.quantity ?? 0) +
        toPositiveQuantity(
          item.quantity,
          1
        ),
    });
  }

  const normalized = Array.from(
    byServiceId.entries()
  ).map(([serviceNodeId, value]) => ({
    serviceNodeId,
    bookingMode:
      value.bookingMode ?? null,
    quantity: value.quantity,
  }));

  const singleModeItems =
    normalized.filter(
      (item) =>
        item.bookingMode ===
        "SINGLE"
    );

  if (!singleModeItems.length) {
    return;
  }

  if (normalized.length > 1) {
    throw new AppError(
      INCOMPATIBLE_COMBINATION_MESSAGE,
      400,
      "INCOMPATIBLE_BOOKING_COMBINATION"
    );
  }

  const onlyItem =
    singleModeItems[0];
  if (
    onlyItem &&
    onlyItem.quantity > 1
  ) {
    throw new AppError(
      SINGLE_SERVICE_MESSAGE,
      400,
      "INVALID_SINGLE_SERVICE_QUANTITY"
    );
  }
};

const resolveRequestedServiceNodeId = (
  item: {
    serviceNodeId?: string;
    serviceId?: string;
  },
  index: number
) => {
  const serviceNodeId =
    typeof item.serviceNodeId === "string" &&
    item.serviceNodeId.trim().length > 0
      ? item.serviceNodeId.trim()
      : typeof item.serviceId === "string" &&
          item.serviceId.trim().length > 0
      ? item.serviceId.trim()
      : "";

  if (!serviceNodeId) {
    throw new AppError(
      `items[${index}].serviceNodeId is required`,
      400
    );
  }

  return serviceNodeId;
};

const computeTotals = async (
  branchId: string,
  items: {
    serviceNodeId?: string;
    serviceId?: string;
    quantity?: number;
    bookingData?: BookingData;
  }[]
) => {
  if (!items || items.length === 0) {
    throw new AppError("At least one service is required", 400);
  }

  const requestedByServiceId =
    new Map<
      string,
      {
        quantity: number;
        bookingData: BookingData;
      }
    >();

  items.forEach((item, index) => {
    const serviceNodeId =
      resolveRequestedServiceNodeId(
        item,
        index
      );
    const quantity = toPositiveQuantity(
      item.quantity,
      1
    );

    const previous =
      requestedByServiceId.get(
        serviceNodeId
      );

    requestedByServiceId.set(
      serviceNodeId,
      {
        quantity:
          (previous?.quantity ?? 0) +
          quantity,
        bookingData:
          toBookingData(
            item.bookingData
          ),
      }
    );
  });

  const serviceIds = Array.from(
    requestedByServiceId.keys()
  );

  const branchServices = await prisma.branchService.findMany({
    where: {
      branchId,
      serviceNodeId: { in: serviceIds },
      isActive: true,
    },
    include: {
      serviceNode: {
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          description: true,
          iconUrl: true,
          coverUrl: true,
          isBookable: true,
          bookingMode: true,
          consultationOnly: true,
          durationMinutes: true,
          durationType: true,
          defaultPrice: true,
          priceType: true,
          pricingType: true,
          bookingFields: true,
          variants: {
            orderBy: {
              sortOrder: "asc",
            },
          },
          pricingRules: {
            orderBy: {
              sortOrder: "asc",
            },
          },
          parentId: true,
          parent: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
    },
  });

  if (branchServices.length !== serviceIds.length) {
    throw new AppError(
      SERVICE_NOT_AVAILABLE_MESSAGE,
      400,
      "SERVICE_NOT_AVAILABLE_IN_BRANCH"
    );
  }

  assertBookingModeCompatibility(
    serviceIds.map(
      (serviceNodeId) => {
        const service =
          branchServices.find(
            (branchService) =>
              branchService.serviceNodeId ===
              serviceNodeId
          );
        const requested =
          requestedByServiceId.get(
            serviceNodeId
          );

        return {
          serviceNodeId,
          bookingMode:
            service?.serviceNode
              .bookingMode ?? null,
          quantity:
            requested?.quantity ?? 1,
        };
      }
    )
  );

  let subtotal = 0;

  const detailedItems = serviceIds.map((serviceNodeId) => {
    const branchService =
      branchServices.find(
        (bs) =>
          bs.serviceNodeId ===
          serviceNodeId
      )!;
    const requested =
      requestedByServiceId.get(
        serviceNodeId
      ) ?? {
        quantity: 1,
        bookingData: {},
      };
    const pricing =
      computeServiceLinePricing({
        basePrice:
          branchService.price ??
          branchService.serviceNode
            .defaultPrice,
        serviceNode:
          branchService.serviceNode,
        bookingData:
          requested.bookingData,
        fallbackQuantity:
          requested.quantity,
      });

    subtotal += pricing.lineTotal;

    return {
      serviceNodeId,
      variantId:
        pricing.selectedVariantId ??
        null,
      quantity: pricing.quantity,
      pricingQuantity:
        pricing.pricingQuantity ??
        null,
      duration:
        pricing.duration ?? null,
      price: pricing.unitPrice,
      lineTotal:
        pricing.lineTotal,
      inputData:
        Object.keys(
          requested.bookingData
        ).length > 0
          ? (requested.bookingData as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      serviceSnapshot:
        buildServiceSnapshot(
          branchService.serviceNode
        ) as Prisma.InputJsonValue,
    };
  });

  return { subtotal, detailedItems };
};

//////////////////////////////////////////////////////
// PREVIEW BOOKING TOTALS (DIRECT CHECKOUT)
//////////////////////////////////////////////////////

export const previewBooking = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);

  const { branchId, items, couponCode } = req.body as {
    branchId: string;
    items: {
      serviceNodeId?: string;
      serviceId?: string;
      quantity?: number;
      bookingData?: BookingData;
    }[];
    couponCode?: string;
  };

  if (!branchId) {
    throw new AppError("branchId is required", 400);
  }

  if (!items || !items.length) {
    throw new AppError("At least one service is required", 400);
  }

  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, isActive: true },
  });

  if (!branch || !branch.isActive) {
    throw new AppError("Selected branch is not available", 400);
  }

  const { subtotal, detailedItems } = await computeTotals(branchId, items);

  const serviceNodeIds = detailedItems.map(
    (item) => item.serviceNodeId
  );
  const serviceSubtotalById = detailedItems.reduce<Record<string, number>>(
    (acc, item) => {
      acc[item.serviceNodeId] = item.price * item.quantity;
      return acc;
    },
    {}
  );

  let discountAmount = 0;
  let couponId: string | undefined;
  let offerId: string | undefined;
  let couponDiscountAmount = 0;
  let offerDiscountAmount = 0;

  if (couponCode) {
    const { coupon, discount } = await validateCouponForAmount(
      couponCode,
      subtotal,
      branchId,
      serviceNodeIds,
      serviceSubtotalById,
      authUser.id,
      serviceNodeIds.length
    );

    discountAmount = discount;
    couponId = coupon.id;
    couponDiscountAmount = discount;
  } else {
    const auto =
      await findBestAutoApplyOfferForAmount(
        subtotal,
        branchId,
        serviceNodeIds,
        serviceSubtotalById,
        authUser.id,
        serviceNodeIds.length
      );

    if (auto) {
      discountAmount = auto.discount;
      offerId = auto.offer.id;
      offerDiscountAmount = auto.discount;
    }
  }

  const taxableAmount = subtotal - discountAmount;
  const taxAmount = computeTaxAmount(taxableAmount);
  const totalAmount = taxableAmount + taxAmount;

  const serviceIds = detailedItems.map((item) => item.serviceNodeId);

  const serviceNodes = await prisma.serviceNode.findMany({
    where: {
      id: { in: serviceIds },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      priceType: true,
      durationMinutes: true,
      defaultPrice: true,
    },
  });

  const serviceMap = new Map(
    serviceNodes.map((node) => [node.id, node])
  );

  const itemsWithService = detailedItems.map((item) => ({
    ...item,
    serviceNode:
      getServiceNodeView({
        serviceNode:
          serviceMap.get(item.serviceNodeId) ?? null,
        serviceSnapshot:
          (item as any).serviceSnapshot,
        fallbackId: item.serviceNodeId,
      }),
    serviceSnapshot:
      (item as any).serviceSnapshot ?? null,
    bookingData: item.inputData ?? null,
  }));

  res.json(
    successResponse(
      {
        branchId,
        couponId: couponId ?? null,
        offerId: offerId ?? null,
        subtotal,
        taxAmount,
        discountAmount,
        couponDiscountAmount,
        offerDiscountAmount,
        totalAmount,
        items: itemsWithService,
      },
      "Booking preview fetched"
    )
  );
});

const canViewBooking = async (
  bookingId: string,
  req: AuthRequest,
  options?: {
    activeOnly?: boolean;
  }
) => {
  const authUser = assertAuthenticatedUser(req);
  const activeOnly =
    options?.activeOnly ?? true;

  const booking = await prisma.booking.findFirst({
    where: {
      id: bookingId,
      ...(activeOnly
        ? { isActive: true }
        : { deletedAt: null }),
    },
  });

  if (!booking) {
    throw new AppError("Booking not found", 404);
  }

  if (booking.userId === authUser.id) {
    return booking;
  }

  if (authUser.role === "SUPER_ADMIN") {
    return booking;
  }

  if (authUser.role === "ADMIN") {
    const assignedBranchIds = await getAssignedBranchIds(authUser.id);

    if (assignedBranchIds.length === 0) {
      return booking;
    }

    if (assignedBranchIds.includes(booking.branchId)) {
      return booking;
    }
  }

  if (authUser.role === "BRANCH_ADMIN") {
    const assignedBranchIds = await getAssignedBranchIds(authUser.id);
    if (assignedBranchIds.includes(booking.branchId)) {
      return booking;
    }
  }

  throw new AppError("Forbidden", 403);
};

//////////////////////////////////////////////////////
// CREATE BOOKING (APP USER)
//////////////////////////////////////////////////////

export const createBooking = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);

  const { branchId, scheduledAt, notes, items, couponCode, addressId, paymentIntent } = req.body as {
    branchId: string;
    scheduledAt: string;
    notes?: string;
    items: {
      serviceNodeId?: string;
      serviceId?: string;
      quantity?: number;
      bookingData?: BookingData;
    }[];
    couponCode?: string;
    addressId?: string;
    paymentIntent?: "pay_now" | "pay_later";
  };

  if (!branchId || !scheduledAt) {
    throw new AppError("branchId and scheduledAt are required", 400);
  }

  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    include: {
      city: true,
    },
  });

  if (!branch || !branch.isActive) {
    throw new AppError("Selected branch is not available", 400);
  }

  const scheduleDate = new Date(scheduledAt);
  if (Number.isNaN(scheduleDate.getTime())) {
    throw new AppError("Invalid scheduledAt datetime", 400);
  }

  await validateBranchScheduledAt({
    branchId: branch.id,
    scheduledAt: scheduleDate,
  });

  const resolvedAddress = addressId
    ? await prisma.address.findFirst({
        where: {
          id: addressId,
          userId: authUser.id,
          isActive: true,
          cityId: branch.cityId,
        },
        include: {
          city: true,
        },
      })
    : await prisma.address.findFirst({
        where: {
          userId: authUser.id,
          isActive: true,
          cityId: branch.cityId,
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
        include: {
          city: true,
        },
      });

  if (!resolvedAddress) {
    throw new AppError("Please select an address for this booking", 400);
  }

  assertAddressWithinBranchRadius({
    branch,
    address: resolvedAddress,
  });

  const { subtotal, detailedItems } = await computeTotals(branchId, items);

  const serviceNodeIds = detailedItems.map(
    (item) => item.serviceNodeId
  );
  const serviceSubtotalById = detailedItems.reduce<Record<string, number>>(
    (acc, item) => {
      acc[item.serviceNodeId] = item.price * item.quantity;
      return acc;
    },
    {}
  );

  let discountAmount = 0;
  let couponId: string | undefined;
  let offerId: string | undefined;
  let couponDiscountAmount = 0;
  let offerDiscountAmount = 0;

  if (couponCode) {
    const { coupon, discount } =
      await validateCouponForAmount(
        couponCode,
        subtotal,
        branchId,
        serviceNodeIds,
        serviceSubtotalById,
        authUser.id,
        serviceNodeIds.length
      );
    discountAmount = discount;
    couponId = coupon.id;
    couponDiscountAmount = discount;
  } else {
    const auto =
      await findBestAutoApplyOfferForAmount(
        subtotal,
        branchId,
        serviceNodeIds,
        serviceSubtotalById,
        authUser.id,
        serviceNodeIds.length
      );

    if (auto) {
      discountAmount = auto.discount;
      offerId = auto.offer.id;
      offerDiscountAmount = auto.discount;
    }
  }

  const taxableAmount = subtotal - discountAmount;
  const taxAmount = computeTaxAmount(taxableAmount);
  const totalAmount = taxableAmount + taxAmount;
  const branchSnapshot =
    buildBranchSnapshot(branch);
  const addressSnapshot =
    buildAddressSnapshot(
      resolvedAddress
    );
  const cartSnapshot = buildCartSnapshot({
    source:
      detailedItems.length > 1
        ? "CART"
        : "DIRECT",
    branch: branchSnapshot,
    address: addressSnapshot,
    couponId: couponId ?? null,
    offerId: offerId ?? null,
    subtotal,
    taxAmount,
    discountAmount,
    couponDiscountAmount,
    offerDiscountAmount,
    totalAmount,
    items: detailedItems,
  });
  const initialBookingStatus =
    getInitialBookingStatus();
  const paymentSettings =
    await getPlatformPaymentSettings();
  const normalizedPaymentIntent =
    paymentIntent === "pay_now"
      ? "pay_now"
      : "pay_later";

  if (
    normalizedPaymentIntent ===
      "pay_later" &&
    totalAmount > 0 &&
    !paymentSettings.allowPayLater
  ) {
    throw new AppError(
      "Pay later is currently unavailable. Please choose online payment.",
      400,
      "PAY_LATER_DISABLED"
    );
  }

  if (
    normalizedPaymentIntent ===
      "pay_now" &&
    totalAmount > 0 &&
    !paymentSettings.paymentFlowEnabled
  ) {
    throw new AppError(
      "Online payment is currently unavailable. Please choose pay later.",
      400,
      "PAYMENT_FLOW_UNAVAILABLE"
    );
  }

  const initialPaymentStatus =
    normalizedPaymentIntent ===
      "pay_later" &&
    totalAmount > 0
      ? "NOT_REQUIRED"
      : getInitialPaymentStatus(
          totalAmount
        );
  const deferActivationUntilPaid =
    normalizedPaymentIntent ===
      "pay_now" &&
    initialPaymentStatus !==
      "NOT_REQUIRED";
  const bookingCreatedMessage =
    deferActivationUntilPaid
      ? "Payment pending. Complete online payment to place this order."
      : normalizedPaymentIntent ===
        "pay_later"
      ? "Booking created successfully. Payment will be collected after the visit."
      : initialPaymentStatus ===
        "NOT_REQUIRED"
      ? "Visit booking created. No online payment is required for this service."
      : "Booking created successfully. Payment can be collected later or completed online when enabled.";

  let booking: any | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      booking = await prisma.booking.create({
        data: {
          displayId: createBookingDisplayId(),
          userId: authUser.id,
          branchId,
          addressId: resolvedAddress.id,
          scheduledAt: scheduleDate,
          notes: notes ?? null,
          subtotal,
          taxAmount,
          totalAmount,
          discountAmount,
          branchSnapshot:
            branchSnapshot as Prisma.InputJsonValue,
          addressSnapshot:
            addressSnapshot as Prisma.InputJsonValue,
          cartSnapshot:
            cartSnapshot as Prisma.InputJsonValue,
          couponId: couponId ?? null,
          offerId: offerId ?? null,
          status: initialBookingStatus,
          paymentStatus:
            initialPaymentStatus,
          isActive:
            !deferActivationUntilPaid,
          items: {
            createMany: {
              data: detailedItems,
            },
          },
          timeline: {
            create: {
              status:
                initialBookingStatus,
              paymentStatus:
                initialPaymentStatus,
              message:
                bookingCreatedMessage,
              createdById: authUser.id,
            },
          },
        },
        include: {
          items: {
            include: {
              serviceNode: true,
            },
          },
          address: {
            include: {
              city: true,
            },
          },
          branch: {
            include: {
              city: true,
            },
          },
        },
      });

      break;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const target = (error.meta as any)?.target;
        const conflictsWithDisplayId = Array.isArray(target)
          ? target.includes("displayId")
          : String(target ?? "").includes("displayId");

        if (conflictsWithDisplayId) {
          booking = null;
          continue;
        }
      }

      throw error;
    }
  }

  if (!booking) {
    throw new AppError("Unable to generate booking id", 500);
  }

  const bookingPayload =
    hydrateBookingForResponse(booking);

  if (!deferActivationUntilPaid) {
    await dispatchBookingPlacedSideEffects(
      booking.id
    );
  }

  res.json(
    successResponse(
      bookingPayload,
      deferActivationUntilPaid
        ? "Payment pending. Complete payment to place the order."
        : "Booking created"
    )
  );
});

//////////////////////////////////////////////////////
// CUSTOMER BOOKING UPLOADS (IMAGES)
//////////////////////////////////////////////////////

export const uploadBookingUploads = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);

    const files = Array.isArray((req as any).files)
      ? ((req as any).files as Express.Multer.File[])
      : [];

    if (!files.length) {
      throw new AppError("No files uploaded", 400);
    }

    const folder = `booking-uploads/${authUser.id}`;

    const uploaded = await Promise.all(
      files.map(async (file) => {
        const result = await uploadToS3(file, folder);

        return prisma.media.create({
          data: {
            url: result.url,
            key: result.key,
            fileName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            folderId: null,
          },
          select: {
            id: true,
            url: true,
            fileName: true,
            mimeType: true,
            size: true,
            width: true,
            height: true,
            createdAt: true,
          },
        });
      })
    );

    res.json(successResponse(uploaded, "Uploaded"));
  }
);

//////////////////////////////////////////////////////
// CUSTOMER BOOKING HISTORY
//////////////////////////////////////////////////////

export const getMyBookings = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);

  const { status } = req.query as { status?: BookingStatus };

  const paymentSyncCandidates =
    await prisma.booking.findMany({
      where: {
        userId: authUser.id,
        deletedAt: null,
        paymentOrders: {
          some: {},
        },
        OR: [
          { isActive: false },
          {
            paymentStatus: {
              in: [
                PaymentStatus.PENDING,
                PaymentStatus.FAILED,
              ],
            },
          },
        ],
        ...(status ? { status } : {}),
      },
      select: {
        id: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 25,
    });

  await syncBookingPaymentsIfNeeded(
    paymentSyncCandidates.map(
      (booking) => booking.id
    )
  );

  const bookings = await prisma.booking.findMany({
    where: {
      userId: authUser.id,
      isActive: true,
      ...(status ? { status } : {}),
    },
    include: {
      items: {
        include: {
          serviceNode: true,
        },
      },
      address: {
        include: {
          city: true,
        },
      },
      branch: {
        include: {
          city: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res.json(
    successResponse(
      bookings.map((booking) =>
        withBookingUserContact(
          hydrateBookingForResponse(
            booking
          )
        )
      ),
      "Bookings fetched"
    )
  );
});

//////////////////////////////////////////////////////
// BOOKING DETAILS (ACCESS CONTROLLED)
//////////////////////////////////////////////////////

export const getBookingById = catchAsync(async (req: AuthRequest, res: Response) => {
  const id = getParam(req.params.id, "bookingId");

  await canViewBooking(id, req, {
    activeOnly: false,
  });
  await syncBookingPaymentStateIfNeeded(id);

  const booking = await prisma.booking.findFirst({
    where: {
      id,
      isActive: true,
    },
    include: {
      items: {
        include: {
          serviceNode: true,
        },
      },
      address: {
        include: {
          city: true,
        },
      },
      branch: {
        include: {
          city: true,
        },
      },
      user: {
        include: {
          profile: true,
          authMethods: {
            select: {
              identifier: true,
              identifierType: true,
              isPrimary: true,
              isVerified: true,
              createdAt: true,
            },
            orderBy: [
              { isPrimary: "desc" },
              { isVerified: "desc" },
              { createdAt: "asc" },
            ],
          },
        },
      },
      timeline: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!booking) {
    throw new AppError("Booking not found", 404);
  }

  const hydratedBooking =
    withBookingUserContact(
      hydrateBookingForResponse(booking)
    );
  const items = Array.isArray(
    hydratedBooking.items
  )
    ? hydratedBooking.items
    : [];

  const uploadLookups = items.flatMap((item) => {
    const serviceNode = (item as any).serviceNode as
      | {
          bookingFields?: unknown;
        }
      | null
      | undefined;

    const uploadFields = toUploadFieldDefinitions(
      serviceNode?.bookingFields
    );

    if (!uploadFields.length) {
      return [];
    }

    const inputData = toRecord(
      (item as any).inputData
    );

    return uploadFields.map((field) => ({
      itemId: item.id,
      key: field.key,
      label: field.label,
      mediaIds: toStringArray(
        inputData[field.key]
      ),
    }));
  });

  const mediaIds = [
    ...new Set(
      uploadLookups.flatMap((row) =>
        row.mediaIds
      )
    ),
  ];

  const media =
    mediaIds.length > 0
      ? await prisma.media.findMany({
          where: {
            id: {
              in: mediaIds,
            },
          },
          select: {
            id: true,
            url: true,
            fileName: true,
          },
        })
      : [];

  const mediaMap = new Map<
    string,
    BookingUploadMedia
  >(
    media.map((m) => [
      m.id,
      {
        id: m.id,
        url: m.url,
        fileName: m.fileName,
      },
    ])
  );

  const inputUploadsByItem = new Map<
    string,
    Array<{
      key: string;
      label: string;
      media: BookingUploadMedia[];
    }>
  >();

  for (const lookup of uploadLookups) {
    const resolved = lookup.mediaIds
      .map((id) => mediaMap.get(id))
      .filter(
        (
          item
        ): item is BookingUploadMedia =>
          Boolean(item)
      );

    if (!resolved.length) {
      continue;
    }

    const existing =
      inputUploadsByItem.get(
        lookup.itemId
      ) ?? [];

    existing.push({
      key: lookup.key,
      label: lookup.label,
      media: resolved,
    });

    inputUploadsByItem.set(
      lookup.itemId,
      existing
    );
  }

  const itemsWithUploads = items.map(
    (item) => ({
      ...item,
      inputUploads:
        inputUploadsByItem.get(item.id) ??
        [],
    })
  );

  res.json(
    successResponse(
      {
        ...hydratedBooking,
        items: itemsWithUploads,
      },
      "Booking details fetched"
    )
  );
});

//////////////////////////////////////////////////////
// CUSTOMER CANCEL BOOKING
//////////////////////////////////////////////////////

export const cancelBooking = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);

    const id = getParam(req.params.id, "bookingId");

    const { reason } = (req.body ?? {}) as {
      reason?: string;
    };

    const booking = await prisma.booking.findFirst({
      where: {
        id,
        isActive: true,
      },
      include: {
        branch: {
          select: {
            id: true,
            cancellationCutoffMinutes: true,
          },
        },
        items: {
          select: {
            serviceNodeId: true,
            serviceSnapshot: true,
            serviceNode: {
              select: {
                id: true,
                cancellationCutoffMinutes: true,
              },
            },
          },
        },
      },
    });

    if (!booking) {
      throw new AppError("Booking not found", 404);
    }

    if (booking.userId !== authUser.id) {
      throw new AppError("Forbidden", 403);
    }

    if (booking.status === "CANCELLED") {
      throw new AppError("Booking is already cancelled", 400);
    }

    if (booking.status === "COMPLETED") {
      throw new AppError(
        "Completed bookings cannot be cancelled",
        400
      );
    }

    if (
      booking.status === "IN_PROGRESS" ||
      booking.status === "WORK_IN_PROGRESS"
    ) {
      throw new AppError(
        "In-progress bookings cannot be cancelled",
        400
      );
    }

    const cutoffMinutes =
      getBookingCancellationCutoffMinutes({
        items: booking.items,
        branch: booking.branch,
        branchSnapshot:
          booking.branchSnapshot,
      });

    const latestAllowedAt = new Date(
      booking.scheduledAt.getTime() -
        cutoffMinutes * 60 * 1000
    );

    if (new Date() > latestAllowedAt) {
      throw new AppError(
        `Cancellation is allowed only up to ${cutoffMinutes} minutes before the scheduled time.`,
        400,
        "CANCELLATION_WINDOW_PASSED"
      );
    }

    const normalizedReason =
      typeof reason === "string"
        ? reason.trim()
        : "";

    const message = normalizedReason
      ? `Cancelled by customer: ${normalizedReason}`
      : "Cancelled by customer.";

    const updated = await prisma.booking.update({
      where: { id },
      data: {
        status: "CANCELLED",
        timeline: {
          create: {
            status: "CANCELLED",
            message,
            createdById: authUser.id,
          },
        },
      },
      include: {
        items: {
          include: {
            serviceNode: true,
          },
        },
        address: {
          include: {
            city: true,
          },
        },
        branch: {
          include: {
            city: true,
          },
        },
      },
    });

    const updatedPayload =
      hydrateBookingForResponse(updated);
    const bookingRef = updated.displayId ?? updated.id;
    const serviceNames =
      getBookingItemNames(
        updatedPayload.items
      );

    try {
      const notifications: Promise<unknown>[] = [
        createNotification({
          userId: authUser.id,
          type: NotificationType.BOOKING_CANCELLED,
          title: `Booking cancelled (${bookingRef})`,
          message: `Your booking for ${serviceNames} has been cancelled.`,
          linkUrl: `/orders/${updated.id}`,
          data: {
            bookingId: updated.id,
            displayId: updated.displayId ?? null,
          },
        }),
        notifyBranchAdmins(updated.branchId, {
          type: NotificationType.BOOKING_CANCELLED,
          title: `Booking cancelled (${bookingRef})`,
          message: `Customer cancelled booking for ${serviceNames}.`,
          linkUrl: `/dashboard/bookings/${updated.id}`,
          data: {
            bookingId: updated.id,
            displayId: updated.displayId ?? null,
          },
        }),
      ];

      // Phase 10 hardening: a professional already assigned/traveling to
      // this job was never notified of a customer cancellation before —
      // they'd only discover it by trying to act on the job and hitting a
      // BOOKING_CANCELLED error. Notify them directly, same as the other
      // actors above.
      if (booking.assignedProfessionalId) {
        notifications.push(
          (async () => {
            const professional =
              await prisma.professionalProfile.findUnique({
                where: { id: booking.assignedProfessionalId! },
                select: { userId: true },
              });

            if (!professional) return;

            await createNotification({
              userId: professional.userId,
              type: NotificationType.BOOKING_CANCELLED,
              title: `Booking cancelled (${bookingRef})`,
              message: `The customer cancelled the booking for ${serviceNames}.`,
              linkUrl: "/professional/jobs",
              data: {
                bookingId: updated.id,
                displayId: updated.displayId ?? null,
              },
            });
          })()
        );
      }

      await Promise.all(notifications);
    } catch (error) {
      console.error("[NOTIFY] Failed to create notifications", {
        bookingId: updated.id,
        error,
      });
    }

    try {
      await cancelDispatchForBooking(updated.id);
    } catch (error) {
      console.error("[DISPATCH] Failed to cancel dispatch", {
        bookingId: updated.id,
        error,
      });
    }

    if (booking.assignedProfessionalId) {
      await recordJobOutcome(
        booking.assignedProfessionalId,
        "CANCELLED"
      );
    }

    res.json(
      successResponse(
        updatedPayload,
        "Booking cancelled"
      )
    );
  }
);

//////////////////////////////////////////////////////
// ADMIN / BRANCH DASHBOARD LISTING
//////////////////////////////////////////////////////

export const listBookingsAdmin = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);

  if (authUser.role !== "ADMIN" && authUser.role !== "SUPER_ADMIN") {
    throw new AppError("Forbidden", 403);
  }

  const {
    status,
    paymentStatus,
    branchId,
    userId,
    search,
    dateField,
    from,
    to,
    view = "all",
    page = "1",
    pageSize = "20",
  } = req.query as DashboardBookingFilters;

  const pageNum =
    Math.max(1, Number(page) || 1);
  const limit = Math.min(
    Math.max(1, Number(pageSize) || 20),
    100
  );
  const skip = (pageNum - 1) * limit;

  let visibilityWhere: Prisma.BookingWhereInput =
    {};

  if (authUser.role === "ADMIN") {
    const assignedBranchIds =
      await getAssignedBranchIds(authUser.id);

    if (assignedBranchIds.length > 0) {
      if (
        branchId &&
        !assignedBranchIds.includes(branchId)
      ) {
        throw new AppError("Forbidden", 403);
      }

      visibilityWhere.branchId = branchId
        ? branchId
        : { in: assignedBranchIds };
    }
  }

  const syncScopeWhere =
    buildDashboardBookingScopeWhere({
      visibilityWhere,
      branchId:
        authUser.role === "SUPER_ADMIN"
          ? branchId
          : undefined,
      userId,
      search,
      dateField,
      from,
      to,
      activeOnly: false,
    });

  const paymentSyncCandidates =
    await prisma.booking.findMany({
      where: combineBookingWhere(
        syncScopeWhere,
        {
          paymentOrders: {
            some: {},
          },
        },
        {
          OR: [
            { isActive: false },
            {
              paymentStatus: {
                in: [
                  PaymentStatus.PENDING,
                  PaymentStatus.FAILED,
                ],
              },
            },
          ],
        }
      ),
      select: {
        id: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: Math.max(limit, 25),
    });

  await syncBookingPaymentsIfNeeded(
    paymentSyncCandidates.map(
      (booking) => booking.id
    )
  );

  const scopeWhere =
    buildDashboardBookingScopeWhere({
      visibilityWhere,
      branchId:
        authUser.role === "SUPER_ADMIN"
          ? branchId
          : undefined,
      userId,
      search,
      dateField,
      from,
      to,
    });

  const where =
    applyDashboardBookingView(scopeWhere, {
      view,
      status,
      paymentStatus,
    });

  const [
    summary,
    paymentSummary,
    total,
    data,
  ] =
    await Promise.all([
      getDashboardBookingSummary(scopeWhere),
      getDashboardPaymentSummary(scopeWhere),
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          scheduledAt: "desc",
        },
        include: bookingListInclude,
      }),
    ]);

  res.json(
    successResponse(
      data.map((booking) =>
        withBookingUserContact(
          hydrateBookingForResponse(
            booking
          )
        )
      ),
      "Bookings fetched",
      {
        page: pageNum,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit),
        summary,
        paymentSummary,
      }
    )
  );
});

export const listBookingsForBranchAdmin = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);

  if (authUser.role !== "BRANCH_ADMIN" && authUser.role !== "ADMIN" && authUser.role !== "SUPER_ADMIN") {
    throw new AppError("Forbidden", 403);
  }

  const {
    status,
    paymentStatus,
    branchId,
    userId,
    search,
    dateField,
    from,
    to,
    view = "all",
    page = "1",
    pageSize = "20",
  } = req.query as DashboardBookingFilters;

  const pageNum =
    Math.max(1, Number(page) || 1);
  const limit = Math.min(
    Math.max(1, Number(pageSize) || 20),
    100
  );
  const skip = (pageNum - 1) * limit;

  const adminBranches = await prisma.branchAdmin.findMany({
    where: {
      userId: authUser.id,
    },
    select: {
      branchId: true,
    },
  });

  const branchIds = adminBranches.map((b) => b.branchId);

  if (!branchIds.length) {
    return res.json(successResponse([], "No branches assigned", {
      page: pageNum,
      pageSize: limit,
      total: 0,
      totalPages: 0,
      summary: {
        total: 0,
        scheduledToday: 0,
        upcoming: 0,
        overdue: 0,
        completed: 0,
        cancelled: 0,
        paymentPending: 0,
      },
    }));
  }

  if (branchId && !branchIds.includes(branchId)) {
    throw new AppError("Forbidden", 403);
  }

  const syncScopeWhere =
    buildDashboardBookingScopeWhere({
      visibilityWhere: {
        branchId: branchId
          ? branchId
          : { in: branchIds },
      },
      userId,
      search,
      dateField,
      from,
      to,
      activeOnly: false,
    });

  const paymentSyncCandidates =
    await prisma.booking.findMany({
      where: combineBookingWhere(
        syncScopeWhere,
        {
          paymentOrders: {
            some: {},
          },
        },
        {
          OR: [
            { isActive: false },
            {
              paymentStatus: {
                in: [
                  PaymentStatus.PENDING,
                  PaymentStatus.FAILED,
                ],
              },
            },
          ],
        }
      ),
      select: {
        id: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: Math.max(limit, 25),
    });

  await syncBookingPaymentsIfNeeded(
    paymentSyncCandidates.map(
      (booking) => booking.id
    )
  );

  const scopeWhere =
    buildDashboardBookingScopeWhere({
      visibilityWhere: {
        branchId: branchId
          ? branchId
          : { in: branchIds },
      },
      userId,
      search,
      dateField,
      from,
      to,
    });

  const where =
    applyDashboardBookingView(scopeWhere, {
      view,
      status,
      paymentStatus,
    });

  const [
    summary,
    paymentSummary,
    total,
    data,
  ] =
    await Promise.all([
      getDashboardBookingSummary(scopeWhere),
      getDashboardPaymentSummary(scopeWhere),
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          scheduledAt: "desc",
        },
        include: bookingListInclude,
      }),
    ]);

  res.json(
    successResponse(
      data.map((booking) =>
        withBookingUserContact(
          hydrateBookingForResponse(
            booking
          )
        )
      ),
      "Branch bookings fetched",
      {
        page: pageNum,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit),
        summary,
        paymentSummary,
      }
    )
  );
});

//////////////////////////////////////////////////////
// STATUS & PAYMENT UPDATES WITH TIMELINE
//////////////////////////////////////////////////////

export const updateBookingStatus = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);
  const id = getParam(req.params.id, "bookingId");

  const { status, message } = req.body as { status: BookingStatus; message?: string };

  if (!status) {
    throw new AppError("status is required", 400);
  }

  await canViewBooking(id, req);

  const existingBooking =
    await prisma.booking.findFirst({
      where: {
        id,
        isActive: true,
      },
      select: {
        id: true,
        status: true,
        assignedProfessionalId: true,
      },
    });

  if (!existingBooking) {
    throw new AppError(
      "Booking not found",
      404
    );
  }

  const booking = await prisma.booking.update({
    where: { id },
    data: {
      status,
      timeline: {
        create: {
          status,
          message: message || `Status updated to ${status}`,
          createdById: authUser.id,
        },
      },
    },
    include: {
      branch: {
        include: {
          city: true,
        },
      },
      user: {
        include: {
          profile: true,
        },
      },
    },
  });

  const bookingRef = booking.displayId ?? booking.id;

  try {
    await createNotification({
      userId: booking.userId,
      type: NotificationType.BOOKING_STATUS_UPDATED,
      title: `Booking update (${bookingRef})`,
      message: `Your booking status is now ${status}.`,
      linkUrl: `/orders/${booking.id}`,
      data: {
        bookingId: booking.id,
        displayId: booking.displayId ?? null,
        status,
        updatedById: authUser.id,
      },
    });
  } catch (error) {
    console.error("[NOTIFY] Failed to create notification", {
      bookingId: booking.id,
      error,
    });
  }

  if (
    existingBooking.status !==
      BookingStatus.COMPLETED &&
    booking.status ===
      BookingStatus.COMPLETED
  ) {
    void sendBookingCompletionEmail(
      booking.id
    ).catch((error) => {
      console.error(
        "[EMAIL] Failed to send booking completion email",
        {
          bookingId: booking.id,
          error,
        }
      );
    });

    try {
      await ensureEarningForBooking(booking.id);
    } catch (error) {
      console.error(
        "[EARNINGS] Failed to create earning after admin status update",
        { bookingId: booking.id, error }
      );
    }

    if (existingBooking.assignedProfessionalId) {
      await recordJobOutcome(
        existingBooking.assignedProfessionalId,
        "COMPLETED"
      );
    }
  }

  if (
    existingBooking.status !== BookingStatus.CANCELLED &&
    booking.status === BookingStatus.CANCELLED &&
    existingBooking.assignedProfessionalId
  ) {
    await recordJobOutcome(
      existingBooking.assignedProfessionalId,
      "CANCELLED"
    );

    // Same gap as the customer-cancel path: an assigned professional was
    // never told an admin cancelled their job out from under them.
    try {
      const professional =
        await prisma.professionalProfile.findUnique({
          where: { id: existingBooking.assignedProfessionalId },
          select: { userId: true },
        });

      if (professional) {
        await createNotification({
          userId: professional.userId,
          type: NotificationType.BOOKING_CANCELLED,
          title: `Booking cancelled (${bookingRef})`,
          message: "This booking was cancelled.",
          linkUrl: "/professional/jobs",
          data: {
            bookingId: booking.id,
            displayId: booking.displayId ?? null,
          },
        });
      }
    } catch (error) {
      console.error(
        "[NOTIFY] Failed to notify assigned professional of cancellation",
        { bookingId: booking.id, error }
      );
    }
  }

  res.json(successResponse(booking, "Booking status updated"));
});

export const updatePaymentStatus = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);
  const id = getParam(req.params.id, "bookingId");

  const { paymentStatus, message } = req.body as { paymentStatus: PaymentStatus; message?: string };

  if (!paymentStatus) {
    throw new AppError("paymentStatus is required", 400);
  }

  await canViewBooking(id, req, {
    activeOnly: false,
  });

  const existingBooking =
    await prisma.booking.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      select: {
        id: true,
        isActive: true,
      },
    });

  if (!existingBooking) {
    throw new AppError(
      "Booking not found",
      404
    );
  }

  let booking = await prisma.booking.update({
    where: { id },
    data: {
      paymentStatus,
      timeline: {
        create: {
          paymentStatus,
          message: message || `Payment status updated to ${paymentStatus}`,
          createdById: authUser.id,
        },
      },
    },
    include: {
      branch: {
        include: {
          city: true,
        },
      },
      user: {
        include: {
          profile: true,
        },
      },
    },
  });

  if (
    !existingBooking.isActive &&
    paymentStatus ===
      PaymentStatus.PAID
  ) {
    await syncBookingPaymentStateIfNeeded(
      id
    );

    const refreshedBooking =
      await prisma.booking.findUnique({
        where: { id },
        include: {
          branch: {
            include: {
              city: true,
            },
          },
          user: {
            include: {
              profile: true,
            },
          },
        },
      });

    if (refreshedBooking) {
      booking = refreshedBooking;
    }
  }

  const bookingRef = booking.displayId ?? booking.id;

  try {
    await createNotification({
      userId: booking.userId,
      type: NotificationType.PAYMENT_STATUS_UPDATED,
      title: `Payment update (${bookingRef})`,
      message: `Payment status is now ${paymentStatus}.`,
      linkUrl: `/orders/${booking.id}`,
      data: {
        bookingId: booking.id,
        displayId: booking.displayId ?? null,
        paymentStatus,
        updatedById: authUser.id,
      },
    });
  } catch (error) {
    console.error("[NOTIFY] Failed to create notification", {
      bookingId: booking.id,
      error,
    });
  }

  if (
    paymentStatus === PaymentStatus.PAID ||
    paymentStatus === PaymentStatus.NOT_REQUIRED
  ) {
    // Covers the case where the booking was already COMPLETED before an
    // admin manually confirmed payment (e.g. cash collected on-site,
    // recorded after the fact) — ensureEarningForBooking is a no-op if the
    // booking isn't COMPLETED yet.
    try {
      await ensureEarningForBooking(booking.id);
    } catch (error) {
      console.error(
        "[EARNINGS] Failed to create earning after admin payment update",
        { bookingId: booking.id, error }
      );
    }
  }

  res.json(successResponse(booking, "Payment status updated"));
});

export const archiveBooking = catchAsync(async (req: AuthRequest, res: Response) => {
  const authUser = assertAuthenticatedUser(req);
  const id = getParam(req.params.id, "bookingId");

  const booking = await canViewBooking(id, req);

  if (!booking.isActive) {
    throw new AppError("Booking already deleted", 404);
  }

  if (
    booking.paymentStatus === PaymentStatus.PAID ||
    booking.paymentStatus === PaymentStatus.REFUNDED
  ) {
    throw new AppError(
      "Paid or refunded bookings cannot be deleted. Keep them for audit history.",
      409,
      "BOOKING_DELETE_BLOCKED"
    );
  }

  const deletableStatuses: BookingStatus[] = [
    BookingStatus.CREATED,
    BookingStatus.PENDING,
    BookingStatus.CANCELLED,
    BookingStatus.QUOTE_REJECTED,
  ];

  if (!deletableStatuses.includes(booking.status)) {
    throw new AppError(
      "Only draft, pending, cancelled, or quote-rejected bookings can be deleted. Cancel or close the booking first.",
      409,
      "BOOKING_DELETE_BLOCKED"
    );
  }

  await moveBookingToTrash(
    id,
    authUser.id,
    "Booking moved to trash from dashboard."
  );

  res.json(
    successResponse(
      null,
      "Booking moved to trash. It will be permanently deleted after 30 days unless restored."
    )
  );
});

//////////////////////////////////////////////////////
// BOOKING TIMELINE
//////////////////////////////////////////////////////

export const getBookingTimeline = catchAsync(async (req: AuthRequest, res: Response) => {
  const id = getParam(req.params.id, "bookingId");

  await canViewBooking(id, req, {
    activeOnly: false,
  });

  const timeline = await prisma.bookingTimeline.findMany({
    where: {
      bookingId: id,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  res.json(successResponse(timeline, "Booking timeline fetched"));
});
