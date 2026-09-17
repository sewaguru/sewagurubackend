import { Response } from "express";
import { NotificationType, Prisma } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { AuthRequest } from "../types/types";
import { validateCouponForAmount } from "../services/coupon.service";
import { findBestAutoApplyOfferForAmount } from "../services/offer.service";
import { createBookingDisplayId } from "../utils/bookingDisplayId";
import {
  buildAddressSnapshot,
  buildBranchSnapshot,
  buildCartSnapshot,
  buildServiceSnapshot,
  getBookingItemNames,
  getServiceNodeView,
  hydrateBookingForResponse,
} from "../utils/bookingSnapshot";
import { computeTaxAmount } from "../utils/tax.util";
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
  BookingData,
  computeServiceLinePricing,
  toBookingData,
  toPositiveQuantity,
} from "../utils/servicePricing.util";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const assertAuthenticatedUser = (req: AuthRequest) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401);
  }
  return req.user;
};

const resolveBranchFromLocation = async ({
  branchId,
  cityId,
  cityName,
}: {
  branchId: string | undefined;
  cityId: string | undefined;
  cityName: string | undefined;
}) => {
  if (branchId) {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { city: true },
    });

    if (!branch || !branch.isActive) {
      throw new AppError("Selected branch not available", 400);
    }

    return branch;
  }

  if (cityId) {
    const branch = await prisma.branch.findFirst({
      where: {
        cityId,
        isActive: true,
      },
      include: { city: true },
    });

    if (!branch) {
      throw new AppError("No active branch available for selected city", 400);
    }

    return branch;
  }

  if (cityName) {
    const branch = await prisma.branch.findFirst({
      where: {
        isActive: true,
        city: {
          name: {
            equals: cityName,
            mode: "insensitive",
          },
        },
      },
      include: { city: true },
    });

    if (!branch) {
      throw new AppError("No active branch available for selected city", 400);
    }

    return branch;
  }

  throw new AppError("branchId or cityId or cityName is required", 400);
};

const SERVICE_NOT_AVAILABLE_MESSAGE =
  "This service is not available in the selected branch.";
const SINGLE_SERVICE_MESSAGE =
  "This service must be booked individually.";
const INCOMPATIBLE_COMBINATION_MESSAGE =
  "This service must be booked individually and cannot be combined with other services.";
const ADDRESS_OUTSIDE_SERVICE_RADIUS_MESSAGE =
  "Service is not available at the selected place for this branch.";
const MAX_BRANCH_SERVICE_RADIUS_KM = 20;

const toRadians = (degrees: number) =>
  (degrees * Math.PI) / 180;

const calculateDistanceKm = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
) => {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const haversine =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) *
      Math.sin(dLon / 2) *
      Math.cos(lat1) *
      Math.cos(lat2);

  const c =
    2 *
    Math.atan2(
      Math.sqrt(haversine),
      Math.sqrt(1 - haversine)
    );

  return earthRadiusKm * c;
};

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
      "INCOMPATIBLE_CART_COMBINATION"
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

const computeCartTotals = async (
  branchId: string,
  items: {
    serviceNodeId: string;
    quantity: number;
    bookingData?: BookingData;
  }[]
) => {
  if (!items.length) {
    throw new AppError("Cart is empty", 400);
  }

  const requestedByService =
    new Map<
      string,
      {
        quantity: number;
        bookingData: BookingData;
      }
    >();

  for (const item of items) {
    const qty = toPositiveQuantity(
      item.quantity,
      1
    );
    const previous =
      requestedByService.get(
        item.serviceNodeId
      );

    requestedByService.set(
      item.serviceNodeId,
      {
        quantity:
          (previous?.quantity ?? 0) +
          qty,
        bookingData:
          toBookingData(
            item.bookingData
          ),
      }
    );
  }

  const serviceIds = Array.from(
    requestedByService.keys()
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

  const nonBookable = branchServices.find(
    (branchService) =>
      !branchService.serviceNode.isBookable
  );

  if (nonBookable) {
    throw new AppError(
      "Only bookable services can be checked out",
      400,
      "SERVICE_NOT_BOOKABLE"
    );
  }

  const consultationOnlyService =
    branchServices.find(
      (branchService) =>
        branchService.serviceNode
          .consultationOnly
    );

  if (consultationOnlyService) {
    throw new AppError(
      "This service must be booked individually as a consultation.",
      400,
      "CONSULTATION_ONLY_SERVICE"
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
          requestedByService.get(
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
    const service = branchServices.find(
      (bs) => bs.serviceNodeId === serviceNodeId
    )!;
    const requested =
      requestedByService.get(
        serviceNodeId
      ) ?? {
        quantity: 1,
        bookingData: {},
      };
    const pricing =
      computeServiceLinePricing({
        basePrice:
          service.price ??
          service.serviceNode
            .defaultPrice,
        serviceNode:
          service.serviceNode,
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
          service.serviceNode
        ) as Prisma.InputJsonValue,
    };
  });

  return { subtotal, detailedItems };
};

const formatCartPayload = async (
  cart: ({
    items: Array<{
      id: string;
      serviceNodeId: string;
      quantity: number;
      price: number;
      serviceNode: unknown;
      createdAt: Date;
    }>;
    branch: {
      id: string;
      name: string;
      address: string;
      pincode: string;
      latitude: number;
      longitude: number;
      serviceRadiusKm: number;
      cancellationCutoffMinutes: number;
      city: {
        id: string;
        name: string;
        state: string;
        country: string;
      };
    };
  } & {
    id: string;
    userId: string;
    branchId: string;
    createdAt: Date;
    updatedAt: Date;
  }) | null
) => {
  if (!cart) {
    return null;
  }

  const subtotal = cart.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const taxAmount = computeTaxAmount(subtotal);
  const totalAmount = subtotal + taxAmount;

  return {
    id: cart.id,
    branchId: cart.branchId,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    items: cart.items,
    branch: {
      id: cart.branch.id,
      name: cart.branch.name,
      address: cart.branch.address,
      pincode: cart.branch.pincode,
      latitude: cart.branch.latitude,
      longitude: cart.branch.longitude,
      serviceRadiusKm: cart.branch.serviceRadiusKm,
      cancellationCutoffMinutes:
        cart.branch.cancellationCutoffMinutes,
      city: cart.branch.city,
    },
    location: {
      cityId: cart.branch.city.id,
      cityName: cart.branch.city.name,
      state: cart.branch.city.state,
      country: cart.branch.city.country,
      branchAddress: cart.branch.address,
      branchPincode: cart.branch.pincode,
      coordinates: {
        latitude: cart.branch.latitude,
        longitude: cart.branch.longitude,
      },
    },
    subtotal,
    taxAmount,
    totalAmount,
    itemCount: cart.items.reduce((count, item) => count + item.quantity, 0),
  };
};

//////////////////////////////////////////////////////
// GET CART
//////////////////////////////////////////////////////

export const getMyCart = catchAsync(async (req: AuthRequest, res: Response) => {
  const user = assertAuthenticatedUser(req);

  const { branchId, cityId, cityName } = req.query as {
    branchId?: string;
    cityId?: string;
    cityName?: string;
  };

  const branch = await resolveBranchFromLocation({ branchId, cityId, cityName });

  const cart = await prisma.cart.findUnique({
    where: {
      userId_branchId: {
        userId: user.id,
        branchId: branch.id,
      },
    },
    include: {
      items: {
        include: {
          serviceNode: {
            include: {
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
            },
          },
        },
      },
      branch: {
        include: {
          city: true,
        },
      },
    },
  });

  const payload = await formatCartPayload(cart);

  return res.json(successResponse(payload, "Cart fetched"));
});

//////////////////////////////////////////////////////
// ADD ITEM
//////////////////////////////////////////////////////

export const addItemToCart = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const { branchId, cityId, cityName, serviceNodeId, quantity } = req.body as {
      branchId?: string;
      cityId?: string;
      cityName?: string;
      serviceNodeId: string;
      quantity?: number;
    };

    if (!branchId) {
      throw new AppError("branchId is required", 400);
    }

    if (!serviceNodeId) {
      throw new AppError("serviceNodeId is required", 400);
    }

    const qty = quantity && quantity > 0 ? quantity : 1;

    const branch = await resolveBranchFromLocation({
      branchId,
      cityId,
      cityName,
    });

    const branchService =
      await prisma.branchService.findFirst({
        where: {
          branchId: branch.id,
          serviceNodeId,
          isActive: true,
        },
        include: {
          serviceNode: {
            select: {
              id: true,
              isBookable: true,
              bookingMode: true,
              consultationOnly: true,
              defaultPrice: true,
            },
          },
        },
      });

    if (!branchService) {
      throw new AppError(
        SERVICE_NOT_AVAILABLE_MESSAGE,
        400,
        "SERVICE_NOT_AVAILABLE_IN_BRANCH"
      );
    }

    if (!branchService.serviceNode.isBookable) {
      throw new AppError(
        "Only bookable services can be added to cart",
        400,
        "SERVICE_NOT_BOOKABLE"
      );
    }

    if (branchService.serviceNode.consultationOnly) {
      throw new AppError(
        "This service must be booked individually as a consultation.",
        400,
        "CONSULTATION_ONLY_SERVICE"
      );
    }

    let cart = await prisma.cart.findUnique({
      where: {
        userId_branchId: {
          userId: user.id,
          branchId: branch.id,
        },
      },
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: {
          userId: user.id,
          branchId: branch.id,
        },
      });
    }

    const existingCartItems =
      await prisma.cartItem.findMany({
        where: {
          cartId: cart.id,
        },
        include: {
          serviceNode: {
            select: {
              id: true,
              bookingMode: true,
            },
          },
        },
      });

    const existingItem =
      existingCartItems.find(
        (item) =>
          item.serviceNodeId ===
          serviceNodeId
      ) ?? null;

    const incomingMode =
      branchService.serviceNode
        .bookingMode;
    const nextQuantity =
      incomingMode === "SINGLE"
        ? 1
        : (existingItem?.quantity ?? 0) +
          qty;

    assertBookingModeCompatibility([
      ...existingCartItems.map(
        (item) => ({
          serviceNodeId:
            item.serviceNodeId,
          bookingMode:
            item.serviceNode
              .bookingMode,
          quantity:
            item.serviceNodeId ===
            serviceNodeId
              ? nextQuantity
              : item.quantity,
        })
      ),
      ...(existingItem
        ? []
        : [
            {
              serviceNodeId,
              bookingMode:
                incomingMode,
              quantity: nextQuantity,
            },
          ]),
    ]);

    const resolvedPrice =
      branchService.price ??
      branchService.serviceNode
        .defaultPrice;

    if (resolvedPrice == null) {
      throw new AppError(
        "Service price not configured",
        400,
        "SERVICE_PRICE_NOT_CONFIGURED"
      );
    }

    if (existingItem) {
      const updated = await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: nextQuantity,
        },
      });

      return res.json(successResponse(updated, "Cart item updated"));
    }

    const item = await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        serviceNodeId,
        quantity: nextQuantity,
        price: resolvedPrice,
      },
    });

    return res.json(successResponse(item, "Item added to cart"));
  }
);

//////////////////////////////////////////////////////
// UPDATE QUANTITY
//////////////////////////////////////////////////////

export const updateCartItemQuantity = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const { itemId } = req.params as { itemId: string };

    const { quantity } = req.body as { quantity: number };

    if (!quantity || quantity < 1) {
      throw new AppError("quantity must be >= 1", 400);
    }

    const item = await prisma.cartItem.findUnique({
      where: { id: itemId },
      include: {
        cart: true,
        serviceNode: {
          select: {
            bookingMode: true,
            consultationOnly: true,
          },
        },
      },
    });

    if (!item || item.cart.userId !== user.id) {
      throw new AppError("Cart item not found", 404);
    }

    if (
      item.serviceNode
        .consultationOnly
    ) {
      throw new AppError(
        "This service must be booked individually as a consultation.",
        400,
        "CONSULTATION_ONLY_SERVICE"
      );
    }

    if (
      item.serviceNode
        .bookingMode === "SINGLE" &&
      quantity > 1
    ) {
      throw new AppError(
        SINGLE_SERVICE_MESSAGE,
        400,
        "INVALID_SINGLE_SERVICE_QUANTITY"
      );
    }

    const updated = await prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity },
    });

    return res.json(successResponse(updated, "Quantity updated"));
  }
);

//////////////////////////////////////////////////////
// REMOVE ITEM
//////////////////////////////////////////////////////

export const removeCartItem = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const { itemId } = req.params as { itemId: string };

    const item = await prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: true },
    });

    if (!item || item.cart.userId !== user.id) {
      throw new AppError("Cart item not found", 404);
    }

    await prisma.cartItem.delete({
      where: { id: itemId },
    });

    return res.json(successResponse(null, "Item removed"));
  }
);

//////////////////////////////////////////////////////
// CLEAR CART
//////////////////////////////////////////////////////

export const clearCart = catchAsync(async (req: AuthRequest, res: Response) => {
  const user = assertAuthenticatedUser(req);

  const { branchId, cityId, cityName } = req.query as {
    branchId?: string;
    cityId?: string;
    cityName?: string;
  };

  const branch = await resolveBranchFromLocation({ branchId, cityId, cityName });

  const cart = await prisma.cart.findUnique({
    where: {
      userId_branchId: {
        userId: user.id,
        branchId: branch.id,
      },
    },
  });

  if (!cart) {
    return res.json(successResponse(null, "Cart empty"));
  }

  await prisma.cartItem.deleteMany({
    where: {
      cartId: cart.id,
    },
  });

  return res.json(successResponse(null, "Cart cleared"));
});

//////////////////////////////////////////////////////
// CHECKOUT
//////////////////////////////////////////////////////

export const previewCartCheckout = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const { branchId, cityId, cityName, couponCode } = req.body as {
      branchId?: string;
      cityId?: string;
      cityName?: string;
      couponCode?: string;
      serviceInputData?: Record<string, Record<string, unknown>>;
    };

    if (!branchId) {
      throw new AppError("branchId is required", 400);
    }

    const branch = await resolveBranchFromLocation({
      branchId,
      cityId,
      cityName,
    });

    const cart = await prisma.cart.findUnique({
      where: {
        userId_branchId: {
          userId: user.id,
          branchId: branch.id,
        },
      },
      include: {
        items: true,
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new AppError("Cart empty", 400);
    }

    const serviceInputData =
      typeof req.body.serviceInputData === "object" &&
      req.body.serviceInputData !== null
        ? (req.body.serviceInputData as Record<string, Record<string, unknown>>)
        : {};

    const payload = cart.items.map((i) => ({
      serviceNodeId: i.serviceNodeId,
      quantity: i.quantity,
      bookingData: serviceInputData[i.serviceNodeId] ?? {},
    }));

    const { subtotal, detailedItems } = await computeCartTotals(
      branch.id,
      payload
    );

    const serviceNodeIds = detailedItems.map((item) => item.serviceNodeId);
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
        branch.id,
        serviceNodeIds,
        serviceSubtotalById,
        user.id,
        serviceNodeIds.length
      );

      discountAmount = discount;
      couponId = coupon.id;
      couponDiscountAmount = discount;
    } else {
      const auto = await findBestAutoApplyOfferForAmount(
        subtotal,
        branch.id,
        serviceNodeIds,
        serviceSubtotalById,
        user.id,
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

    const serviceNodes = await prisma.serviceNode.findMany({
      where: {
        id: { in: serviceNodeIds },
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

    const serviceMap = new Map(serviceNodes.map((node) => [node.id, node]));

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

    return res.json(
      successResponse(
        {
          branchId: branch.id,
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
        "Cart checkout preview fetched"
      )
    );
  }
);

export const checkoutCartToBooking = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const { branchId, cityId, cityName, scheduledAt, notes, couponCode, addressId, paymentIntent } = req.body as {
      branchId?: string;
      cityId?: string;
      cityName?: string;
      scheduledAt: string;
      notes?: string;
      couponCode?: string;
      addressId?: string;
      paymentIntent?: "pay_now" | "pay_later";
      serviceInputData?: Record<
        string,
        Record<string, unknown>
      >;
    };

    if (!scheduledAt) {
      throw new AppError("scheduledAt required", 400);
    }

    const branch = await resolveBranchFromLocation({ branchId, cityId, cityName });

    const cart = await prisma.cart.findUnique({
      where: {
        userId_branchId: {
          userId: user.id,
          branchId: branch.id,
        },
      },
      include: {
        items: true,
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new AppError("Cart empty", 400);
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
            userId: user.id,
            isActive: true,
            cityId: branch.cityId,
          },
          include: {
            city: true,
          },
        })
      : await prisma.address.findFirst({
          where: {
            userId: user.id,
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

    const serviceInputData =
      typeof req.body.serviceInputData ===
      "object" &&
      req.body.serviceInputData !== null
        ? (req.body
            .serviceInputData as Record<
            string,
            Record<
              string,
              unknown
            >
          >)
        : {};

    const payload = cart.items.map((i) => ({
      serviceNodeId: i.serviceNodeId,
      quantity: i.quantity,
      bookingData:
        serviceInputData[
          i.serviceNodeId
        ] ?? {},
    }));

    const { subtotal, detailedItems } = await computeCartTotals(
      branch.id,
      payload
    );

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
        branch.id,
        serviceNodeIds,
        serviceSubtotalById,
        user.id,
        serviceNodeIds.length
      );

      discountAmount = discount;
      couponId = coupon.id;
      couponDiscountAmount = discount;
    } else {
      const auto =
        await findBestAutoApplyOfferForAmount(
          subtotal,
          branch.id,
          serviceNodeIds,
          serviceSubtotalById,
          user.id,
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
      source: "CART",
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
            userId: user.id,
            branchId: branch.id,
            addressId: resolvedAddress.id,
            scheduledAt: scheduleDate,
            notes: notes ?? null,
            subtotal,
            taxAmount,
            discountAmount,
            totalAmount,
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
                createdById: user.id,
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

    await prisma.cartItem.deleteMany({
      where: {
        cartId: cart.id,
      },
    });

    return res.json(
      successResponse(
        bookingPayload,
        deferActivationUntilPaid
          ? "Payment pending. Complete payment to place the order."
          : "Booking created"
      )
    );
  }
);
