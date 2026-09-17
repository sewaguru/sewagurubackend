type JsonRecord = Record<string, unknown>;

type ServiceNodeSnapshotSource = {
  id: string;
  name: string;
  slug?: string | null;
  type?: string | null;
  description?: string | null;
  iconUrl?: string | null;
  coverUrl?: string | null;
  isBookable?: boolean | null;
  bookingMode?: string | null;
  consultationOnly?: boolean | null;
  durationMinutes?: number | null;
  durationType?: string | null;
  priceType?: string | null;
  pricingType?: string | null;
  defaultPrice?: number | null;
  cancellationCutoffMinutes?: number | null;
  bookingFields?: unknown;
  variants?: unknown;
  pricingRules?: unknown;
  parentId?: string | null;
  parent?: {
    id?: string | null;
    name?: string | null;
    slug?: string | null;
  } | null;
};

type BranchSnapshotSource = {
  id: string;
  name: string;
  address?: string | null;
  pincode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  cancellationCutoffMinutes?: number | null;
  cityId?: string | null;
  city?: {
    id?: string | null;
    name?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
};

type AddressSnapshotSource = {
  id: string;
  label?: string | null;
  customLabel?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  landmark?: string | null;
  locality?: string | null;
  pincode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  placeId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  cityId?: string | null;
  state?: string | null;
  country?: string | null;
  city?: {
    id?: string | null;
    name?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
};

type CartSnapshotItemSource = {
  serviceNodeId: string;
  quantity: number;
  price: number;
  inputData?: unknown;
  serviceSnapshot?: unknown;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const asString = (
  value: unknown
) =>
  typeof value === "string"
    ? value
    : null;

const asNumber = (
  value: unknown
) =>
  typeof value === "number" &&
  Number.isFinite(value)
    ? value
    : null;

const asNonNegativeNumber = (
  value: unknown
) => {
  const numberValue =
    asNumber(value);

  if (
    numberValue === null ||
    numberValue < 0
  ) {
    return null;
  }

  return numberValue;
};

const asBoolean = (
  value: unknown
) =>
  typeof value === "boolean"
    ? value
    : null;

const asArray = (value: unknown) =>
  Array.isArray(value)
    ? value
    : null;

const toJsonRecord = (
  value: unknown
) => {
  if (!isRecord(value)) {
    return null;
  }

  return value;
};

export type ServiceSnapshot = {
  serviceNodeId: string;
  name: string;
  slug: string | null;
  type: string | null;
  description: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
  isBookable: boolean;
  bookingMode: string | null;
  consultationOnly: boolean;
  durationMinutes: number | null;
  durationType: string | null;
  priceType: string | null;
  pricingType: string | null;
  defaultPrice: number | null;
  cancellationCutoffMinutes: number | null;
  bookingFields: unknown[] | null;
  variants: unknown[] | null;
  pricingRules: unknown[] | null;
  parent: {
    id: string | null;
    name: string | null;
    slug: string | null;
  } | null;
};

export type BranchSnapshot = {
  id: string;
  name: string;
  address: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  cancellationCutoffMinutes: number | null;
  city: {
    id: string | null;
    name: string | null;
    state: string | null;
    country: string | null;
  } | null;
};

export type AddressSnapshot = {
  id: string;
  label: string | null;
  customLabel: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  landmark: string | null;
  locality: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  city: {
    id: string | null;
    name: string | null;
    state: string | null;
    country: string | null;
  } | null;
  state: string | null;
  country: string | null;
};

export type CartSnapshot = {
  source: "DIRECT" | "CART";
  branch: BranchSnapshot | null;
  address: AddressSnapshot | null;
  couponId: string | null;
  offerId: string | null;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  couponDiscountAmount: number;
  offerDiscountAmount: number;
  totalAmount: number;
  itemCount: number;
  items: Array<{
    serviceNodeId: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    bookingData: JsonRecord | null;
    service: ServiceSnapshot | null;
  }>;
};

export const DEFAULT_CANCELLATION_CUTOFF_MINUTES =
  60;

export const buildServiceSnapshot = (
  serviceNode: ServiceNodeSnapshotSource
): ServiceSnapshot => ({
  serviceNodeId: serviceNode.id,
  name: serviceNode.name,
  slug: serviceNode.slug ?? null,
  type: serviceNode.type ?? null,
  description:
    serviceNode.description ?? null,
  iconUrl: serviceNode.iconUrl ?? null,
  coverUrl:
    serviceNode.coverUrl ?? null,
  isBookable:
    serviceNode.isBookable === true,
  bookingMode:
    serviceNode.bookingMode ?? null,
  consultationOnly:
    serviceNode.consultationOnly === true,
  durationMinutes:
    serviceNode.durationMinutes ?? null,
  durationType:
    serviceNode.durationType ?? null,
  priceType:
    serviceNode.priceType ?? null,
  pricingType:
    serviceNode.pricingType ?? null,
  defaultPrice:
    serviceNode.defaultPrice ?? null,
  cancellationCutoffMinutes:
    serviceNode.cancellationCutoffMinutes ??
    null,
  bookingFields:
    asArray(serviceNode.bookingFields) ??
    null,
  variants:
    asArray(serviceNode.variants) ??
    null,
  pricingRules:
    asArray(serviceNode.pricingRules) ??
    null,
  parent: serviceNode.parent
    ? {
        id:
          serviceNode.parent.id ?? null,
        name:
          serviceNode.parent.name ??
          null,
        slug:
          serviceNode.parent.slug ??
          null,
      }
    : null,
});

export const buildBranchSnapshot = (
  branch: BranchSnapshotSource
): BranchSnapshot => ({
  id: branch.id,
  name: branch.name,
  address: branch.address ?? null,
  pincode: branch.pincode ?? null,
  latitude: branch.latitude ?? null,
  longitude: branch.longitude ?? null,
  cancellationCutoffMinutes:
    branch.cancellationCutoffMinutes ?? null,
  city: branch.city
    ? {
        id: branch.city.id ?? branch.cityId ?? null,
        name: branch.city.name ?? null,
        state: branch.city.state ?? null,
        country:
          branch.city.country ?? null,
      }
    : branch.cityId
      ? {
          id: branch.cityId,
          name: null,
          state: null,
          country: null,
        }
      : null,
});

export const buildAddressSnapshot = (
  address: AddressSnapshotSource
): AddressSnapshot => ({
  id: address.id,
  label: address.label ?? null,
  customLabel:
    address.customLabel ?? null,
  addressLine1:
    address.addressLine1 ?? null,
  addressLine2:
    address.addressLine2 ?? null,
  landmark: address.landmark ?? null,
  locality: address.locality ?? null,
  pincode: address.pincode ?? null,
  latitude: address.latitude ?? null,
  longitude:
    address.longitude ?? null,
  placeId: address.placeId ?? null,
  contactName:
    address.contactName ?? null,
  contactPhone:
    address.contactPhone ?? null,
  city: address.city
    ? {
        id: address.city.id ?? address.cityId ?? null,
        name:
          address.city.name ?? null,
        state:
          address.city.state ?? null,
        country:
          address.city.country ??
          null,
      }
    : address.cityId
      ? {
          id: address.cityId,
          name: null,
          state: null,
          country: null,
        }
      : null,
  state: address.state ?? null,
  country: address.country ?? null,
});

export const readServiceSnapshot = (
  value: unknown
): ServiceSnapshot | null => {
  const record = toJsonRecord(value);

  if (!record) {
    return null;
  }

  const serviceNodeId =
    asString(record.serviceNodeId);
  const name = asString(record.name);

  if (!serviceNodeId || !name) {
    return null;
  }

  const parent = toJsonRecord(record.parent);

  return {
    serviceNodeId,
    name,
    slug: asString(record.slug),
    type: asString(record.type),
    description:
      asString(record.description),
    iconUrl:
      asString(record.iconUrl),
    coverUrl:
      asString(record.coverUrl),
    isBookable:
      asBoolean(record.isBookable) === true,
    bookingMode:
      asString(record.bookingMode),
    consultationOnly:
      asBoolean(record.consultationOnly) ===
      true,
    durationMinutes:
      asNumber(record.durationMinutes),
    durationType:
      asString(record.durationType),
    priceType:
      asString(record.priceType),
    pricingType:
      asString(record.pricingType),
    defaultPrice:
      asNumber(record.defaultPrice),
    cancellationCutoffMinutes:
      asNonNegativeNumber(
        record.cancellationCutoffMinutes
      ),
    bookingFields:
      asArray(record.bookingFields),
    variants:
      asArray(record.variants),
    pricingRules:
      asArray(record.pricingRules),
    parent: parent
      ? {
          id: asString(parent.id),
          name: asString(parent.name),
          slug: asString(parent.slug),
        }
      : null,
  };
};

export const readBranchSnapshot = (
  value: unknown
): BranchSnapshot | null => {
  const record = toJsonRecord(value);

  if (!record) {
    return null;
  }

  const id = asString(record.id);
  const name = asString(record.name);

  if (!id || !name) {
    return null;
  }

  const city = toJsonRecord(record.city);

  return {
    id,
    name,
    address:
      asString(record.address),
    pincode:
      asString(record.pincode),
    latitude:
      asNumber(record.latitude),
    longitude:
      asNumber(record.longitude),
    cancellationCutoffMinutes:
      asNonNegativeNumber(
        record.cancellationCutoffMinutes
      ),
    city: city
      ? {
          id: asString(city.id),
          name: asString(city.name),
          state: asString(city.state),
          country:
            asString(city.country),
        }
      : null,
  };
};

export const readAddressSnapshot = (
  value: unknown
): AddressSnapshot | null => {
  const record = toJsonRecord(value);

  if (!record) {
    return null;
  }

  const id = asString(record.id);

  if (!id) {
    return null;
  }

  const city = toJsonRecord(record.city);

  return {
    id,
    label: asString(record.label),
    customLabel:
      asString(record.customLabel),
    addressLine1:
      asString(record.addressLine1),
    addressLine2:
      asString(record.addressLine2),
    landmark:
      asString(record.landmark),
    locality:
      asString(record.locality),
    pincode:
      asString(record.pincode),
    latitude:
      asNumber(record.latitude),
    longitude:
      asNumber(record.longitude),
    placeId:
      asString(record.placeId),
    contactName:
      asString(record.contactName),
    contactPhone:
      asString(record.contactPhone),
    city: city
      ? {
          id: asString(city.id),
          name: asString(city.name),
          state: asString(city.state),
          country:
            asString(city.country),
        }
      : null,
    state: asString(record.state),
    country:
      asString(record.country),
  };
};

export const buildCartSnapshot = ({
  source,
  branch,
  address,
  couponId,
  offerId,
  subtotal,
  taxAmount,
  discountAmount,
  couponDiscountAmount,
  offerDiscountAmount,
  totalAmount,
  items,
}: {
  source: "DIRECT" | "CART";
  branch: BranchSnapshot | null;
  address: AddressSnapshot | null;
  couponId?: string | null;
  offerId?: string | null;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  couponDiscountAmount: number;
  offerDiscountAmount: number;
  totalAmount: number;
  items: CartSnapshotItemSource[];
}): CartSnapshot => ({
  source,
  branch,
  address,
  couponId: couponId ?? null,
  offerId: offerId ?? null,
  subtotal,
  taxAmount,
  discountAmount,
  couponDiscountAmount,
  offerDiscountAmount,
  totalAmount,
  itemCount: items.reduce(
    (count, item) =>
      count + item.quantity,
    0
  ),
  items: items.map((item) => ({
    serviceNodeId:
      item.serviceNodeId,
    quantity: item.quantity,
    unitPrice: item.price,
    lineTotal:
      item.price * item.quantity,
    bookingData:
      toJsonRecord(item.inputData),
    service:
      readServiceSnapshot(
        item.serviceSnapshot
      ),
  })),
});

export const getServiceNodeView = ({
  serviceNode,
  serviceSnapshot,
  fallbackId,
}: {
  serviceNode?: {
    id?: string | null;
    name?: string | null;
    slug?: string | null;
    consultationOnly?: boolean | null;
    durationMinutes?: number | null;
    durationType?: string | null;
    defaultPrice?: number | null;
    priceType?: string | null;
    pricingType?: string | null;
    cancellationCutoffMinutes?: number | null;
    bookingFields?: unknown;
    variants?: unknown;
    pricingRules?: unknown;
  } | null;
  serviceSnapshot?: unknown;
  fallbackId?: string | null;
}) => {
  const snapshot =
    readServiceSnapshot(
      serviceSnapshot
    );

  if (snapshot) {
    return {
      id:
        snapshot.serviceNodeId ??
        fallbackId ??
        null,
      name: snapshot.name,
      slug: snapshot.slug,
      consultationOnly:
        snapshot.consultationOnly,
      durationMinutes:
        snapshot.durationMinutes,
      durationType:
        snapshot.durationType,
      defaultPrice:
        snapshot.defaultPrice,
      cancellationCutoffMinutes:
        snapshot.cancellationCutoffMinutes,
      priceType:
        snapshot.priceType,
      pricingType:
        snapshot.pricingType,
      bookingFields:
        snapshot.bookingFields,
      variants:
        snapshot.variants,
      pricingRules:
        snapshot.pricingRules,
    };
  }

  if (serviceNode) {
    return {
      id:
        serviceNode.id ??
        fallbackId ??
        null,
      name:
        serviceNode.name ?? "Service",
      slug:
        serviceNode.slug ?? null,
      consultationOnly:
        serviceNode.consultationOnly ===
        true,
      durationMinutes:
        asNumber(
          serviceNode.durationMinutes
        ),
      durationType:
        asString(
          serviceNode.durationType
        ),
      defaultPrice:
        asNumber(
          serviceNode.defaultPrice
        ),
      cancellationCutoffMinutes:
        asNonNegativeNumber(
          serviceNode.cancellationCutoffMinutes
        ),
      priceType:
        asString(
          serviceNode.priceType
        ),
      pricingType:
        asString(
          serviceNode.pricingType
        ),
      bookingFields:
        serviceNode.bookingFields ?? null,
      variants:
        asArray(
          serviceNode.variants
        ),
      pricingRules:
        asArray(
          serviceNode.pricingRules
        ),
    };
  }

  return {
    id: fallbackId ?? null,
    name: "Service",
    slug: null,
    consultationOnly: false,
    durationMinutes: null,
    durationType: null,
    defaultPrice: null,
    cancellationCutoffMinutes: null,
    priceType: null,
    pricingType: null,
    bookingFields: null,
    variants: null,
    pricingRules: null,
  };
};

const resolveBranchCancellationCutoffMinutes = ({
  branch,
  branchSnapshot,
}: {
  branch?: unknown;
  branchSnapshot?: unknown;
}) => {
  const snapshot =
    readBranchSnapshot(
      branchSnapshot
    );

  if (
    snapshot !== null &&
    snapshot.cancellationCutoffMinutes !==
      null
  ) {
    return (
      snapshot.cancellationCutoffMinutes
    );
  }

  if (
    isRecord(branch) &&
    asNonNegativeNumber(
      branch.cancellationCutoffMinutes
    ) !== null
  ) {
    return asNonNegativeNumber(
      branch.cancellationCutoffMinutes
    ) as number;
  }

  return DEFAULT_CANCELLATION_CUTOFF_MINUTES;
};

const resolveItemCancellationCutoffMinutes = ({
  item,
  branchCutoffMinutes,
}: {
  item: unknown;
  branchCutoffMinutes: number;
}) => {
  if (!isRecord(item)) {
    return branchCutoffMinutes;
  }

  const snapshot =
    readServiceSnapshot(
      item.serviceSnapshot
    );

  if (
    snapshot !== null &&
    snapshot.cancellationCutoffMinutes !==
      null
  ) {
    return (
      snapshot.cancellationCutoffMinutes
    );
  }

  if (
    isRecord(item.serviceNode) &&
    asNonNegativeNumber(
      item.serviceNode
        .cancellationCutoffMinutes
    ) !== null
  ) {
    return asNonNegativeNumber(
      item.serviceNode
        .cancellationCutoffMinutes
    ) as number;
  }

  return branchCutoffMinutes;
};

export const getBookingCancellationCutoffMinutes = ({
  items,
  branch,
  branchSnapshot,
}: {
  items?: unknown;
  branch?: unknown;
  branchSnapshot?: unknown;
}) => {
  const branchCutoffMinutes =
    resolveBranchCancellationCutoffMinutes({
      branch,
      branchSnapshot,
    });
  const bookingItems = Array.isArray(items)
    ? items
    : [];

  if (!bookingItems.length) {
    return branchCutoffMinutes;
  }

  return bookingItems.reduce(
    (strictestCutoffMinutes, item) =>
      Math.max(
        strictestCutoffMinutes,
        resolveItemCancellationCutoffMinutes({
          item,
          branchCutoffMinutes,
        })
      ),
    0
  );
};

export const hydrateBookingForResponse = <
  T extends {
    branch?: unknown;
    branchSnapshot?: unknown;
    address?: unknown;
    addressSnapshot?: unknown;
    items?: unknown;
  },
>(
  booking: T
) => {
  const branchSnapshot =
    readBranchSnapshot(
      (booking as JsonRecord)
        .branchSnapshot
    );
  const addressSnapshot =
    readAddressSnapshot(
      (booking as JsonRecord)
        .addressSnapshot
    );

  const branchRecord = isRecord(
    booking.branch
  )
    ? booking.branch
    : null;
  const addressRecord = isRecord(
    booking.address
  )
    ? booking.address
    : null;
  const items = Array.isArray(
    booking.items
  )
    ? booking.items
    : [];

  const hydratedItems = items.map(
    (item) => {
      const itemRecord = isRecord(item)
        ? item
        : {};

      return {
        ...itemRecord,
        serviceSnapshot:
          readServiceSnapshot(
            itemRecord.serviceSnapshot
          ),
        serviceNode:
          getServiceNodeView({
            serviceNode: isRecord(
              itemRecord.serviceNode
            )
              ? (itemRecord.serviceNode as {
                  id?: string | null;
                  name?: string | null;
                  slug?: string | null;
                  bookingFields?: unknown;
                })
              : null,
            serviceSnapshot:
              itemRecord.serviceSnapshot,
            fallbackId:
              asString(
                itemRecord.serviceNodeId
              ),
          }),
      };
    }
  );

  const branchCity = branchSnapshot?.city ??
    (branchRecord &&
    isRecord(branchRecord.city)
      ? {
          id: asString(
            branchRecord.city.id
          ),
          name: asString(
            branchRecord.city.name
          ),
          state: asString(
            branchRecord.city.state
          ),
          country: asString(
            branchRecord.city.country
          ),
        }
      : null);

  const addressCity = addressSnapshot?.city ??
    (addressRecord &&
    isRecord(addressRecord.city)
      ? {
          id: asString(
            addressRecord.city.id
          ),
          name: asString(
            addressRecord.city.name
          ),
          state: asString(
            addressRecord.city.state
          ),
          country: asString(
            addressRecord.city.country
          ),
        }
      : null);

  const effectiveCancellationCutoffMinutes =
    getBookingCancellationCutoffMinutes({
      items,
      branch:
        branchSnapshot ?? booking.branch,
      branchSnapshot:
        (booking as JsonRecord)
          .branchSnapshot,
    });

  return {
    ...booking,
    effectiveCancellationCutoffMinutes,
    branchSnapshot,
    addressSnapshot,
    branch: branchSnapshot
      ? {
          ...branchRecord,
          id: branchSnapshot.id,
          name: branchSnapshot.name,
          address:
            branchSnapshot.address,
          pincode:
            branchSnapshot.pincode,
          latitude:
            branchSnapshot.latitude,
          longitude:
            branchSnapshot.longitude,
          cancellationCutoffMinutes:
            branchSnapshot.cancellationCutoffMinutes,
          city: branchCity,
        }
      : booking.branch,
    address: addressSnapshot
      ? {
          ...addressRecord,
          id: addressSnapshot.id,
          label: addressSnapshot.label,
          customLabel:
            addressSnapshot.customLabel,
          addressLine1:
            addressSnapshot.addressLine1,
          addressLine2:
            addressSnapshot.addressLine2,
          landmark:
            addressSnapshot.landmark,
          locality:
            addressSnapshot.locality,
          pincode:
            addressSnapshot.pincode,
          latitude:
            addressSnapshot.latitude,
          longitude:
            addressSnapshot.longitude,
          placeId:
            addressSnapshot.placeId,
          contactName:
            addressSnapshot.contactName,
          contactPhone:
            addressSnapshot.contactPhone,
          city: addressCity,
          state: addressSnapshot.state,
          country:
            addressSnapshot.country,
        }
      : booking.address,
    items: hydratedItems,
  };
};

export const getBookingItemNames = (
  items: unknown,
  max = 3
) => {
  if (!Array.isArray(items)) {
    return "Service";
  }

  const names = items
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const snapshot =
        readServiceSnapshot(
          item.serviceSnapshot
        );

      if (snapshot?.name) {
        return snapshot.name;
      }

      if (
        isRecord(item.serviceNode) &&
        typeof item.serviceNode.name ===
          "string"
      ) {
        return item.serviceNode.name;
      }

      return null;
    })
    .filter(
      (name): name is string =>
        typeof name === "string" &&
        name.trim().length > 0
    )
    .slice(0, max);

  return names.length
    ? names.join(", ")
    : "Service";
};
