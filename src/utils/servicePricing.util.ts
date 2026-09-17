import { AppError } from "./AppError";

export type BookingData = Record<
  string,
  unknown
>;

type ServiceBookingFieldPricingRole =
  | "AREA"
  | "DISTANCE"
  | "QUANTITY";

type ServiceBookingFieldOptionPricingType =
  | "ADD"
  | "OVERRIDE";

type ServicePricingType =
  | "FIXED"
  | "VARIABLE"
  | "CONSULTATION";

type ServicePricingRuleType =
  | "PER_HOUR"
  | "PER_UNIT"
  | "PER_PERSON"
  | "PER_SQFT";

type ServicePricingNode = {
  priceType?: string | null;
  pricingType?: string | null;
  consultationOnly?: boolean | null;
  durationType?: string | null;
  bookingMode?: string | null;
  durationMinutes?: number | null;
  bookingFields?: unknown;
  variants?: unknown;
  pricingRules?: unknown;
};

type NormalizedSelectOption = {
  label: string;
  price: number | null;
  pricingType: ServiceBookingFieldOptionPricingType | null;
};

type NormalizedBookingField = {
  key: string;
  type: string;
  affectsPricing: boolean;
  pricingRole: ServiceBookingFieldPricingRole | null;
  options: NormalizedSelectOption[];
  booleanConfig: {
    truePrice: number | null;
  } | null;
};

type NormalizedServiceVariant = {
  id: string;
  name: string;
  price: number;
};

type NormalizedPricingRule = {
  id: string | null;
  type: ServicePricingRuleType;
  baseRate: number;
};

const PRICING_ROLE_BY_MODEL = {
  AREA_BASED: "AREA",
  DISTANCE_BASED: "DISTANCE",
  QUANTITY_BASED: "QUANTITY",
} as const;

const DYNAMIC_PRICING_TYPES =
  new Set<ServicePricingType>([
    "FIXED",
    "VARIABLE",
    "CONSULTATION",
  ]);

const DYNAMIC_PRICING_RULE_TYPES =
  new Set<ServicePricingRuleType>([
    "PER_HOUR",
    "PER_UNIT",
    "PER_PERSON",
    "PER_SQFT",
  ]);

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

const toOptionalNumber = (
  value: unknown
) => {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed =
    typeof value === "number"
      ? value
      : Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
};

const roundMoney = (
  value: number
) =>
  Math.round(
    (value + Number.EPSILON) * 100
  ) / 100;

const normalizeDynamicPricingType = (
  value: unknown
): ServicePricingType | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized =
    value.toUpperCase();

  return DYNAMIC_PRICING_TYPES.has(
    normalized as ServicePricingType
  )
    ? (normalized as ServicePricingType)
    : null;
};

const normalizeServiceVariants = (
  variants: unknown
): NormalizedServiceVariant[] => {
  if (!Array.isArray(variants)) {
    return [];
  }

  return variants
    .map((variant) => {
      if (
        typeof variant !== "object" ||
        variant === null
      ) {
        return null;
      }

      const record =
        variant as Record<
          string,
          unknown
        >;
      const id =
        typeof record.id === "string"
          ? record.id
          : "";
      const name =
        typeof record.name === "string"
          ? record.name.trim()
          : "";
      const price =
        toOptionalNumber(
          record.price
        );

      if (
        !id ||
        !name ||
        price == null
      ) {
        return null;
      }

      return {
        id,
        name,
        price,
      };
    })
    .filter(
      (
        variant
      ): variant is NormalizedServiceVariant =>
        variant !== null
    );
};

const normalizePricingRules = (
  pricingRules: unknown
): NormalizedPricingRule[] => {
  if (!Array.isArray(pricingRules)) {
    return [];
  }

  return pricingRules
    .map((rule) => {
      if (
        typeof rule !== "object" ||
        rule === null
      ) {
        return null;
      }

      const record =
        rule as Record<
          string,
          unknown
        >;
      const rawType =
        typeof record.type ===
        "string"
          ? record.type.toUpperCase()
          : "";
      const baseRate =
        toOptionalNumber(
          record.baseRate
        );

      if (
        !DYNAMIC_PRICING_RULE_TYPES.has(
          rawType as ServicePricingRuleType
        ) ||
        baseRate == null
      ) {
        return null;
      }

      return {
        id:
          typeof record.id ===
          "string"
            ? record.id
            : null,
        type:
          rawType as ServicePricingRuleType,
        baseRate,
      };
    })
    .filter(
      (
        rule
      ): rule is NormalizedPricingRule =>
        rule !== null
    );
};

const toPositiveNumber = (
  value: unknown
) => {
  const parsed =
    toOptionalNumber(value);

  if (
    parsed == null ||
    parsed <= 0
  ) {
    return null;
  }

  return parsed;
};

const resolvePricingQuantityInput = ({
  bookingData,
  fallbackQuantity,
  pricingRules,
}: {
  bookingData: BookingData;
  fallbackQuantity: number;
  pricingRules: NormalizedPricingRule[];
}) => {
  const hasQuantityRule =
    pricingRules.some(
      (rule) =>
        rule.type !== "PER_HOUR"
    );

  if (!hasQuantityRule) {
    return null;
  }

  return (
    toPositiveNumber(
      bookingData.quantity
    ) ??
    toPositiveNumber(
      fallbackQuantity
    )
  );
};

const resolveDurationInput = ({
  bookingData,
  serviceNode,
  pricingRules,
}: {
  bookingData: BookingData;
  serviceNode: ServicePricingNode;
  pricingRules: NormalizedPricingRule[];
}) => {
  const hasDurationRule =
    pricingRules.some(
      (rule) =>
        rule.type === "PER_HOUR"
    );

  if (!hasDurationRule) {
    return null;
  }

  const directDuration =
    toPositiveNumber(
      bookingData.duration
    );

  if (directDuration != null) {
    return directDuration;
  }

  if (
    serviceNode.durationType ===
      "FIXED" &&
    typeof serviceNode.durationMinutes ===
      "number" &&
    Number.isFinite(
      serviceNode.durationMinutes
    ) &&
    serviceNode.durationMinutes > 0
  ) {
    return roundMoney(
      serviceNode.durationMinutes /
        60
    );
  }

  return null;
};

const resolveSelectedVariant = (
  serviceNode: ServicePricingNode,
  bookingData: BookingData
) => {
  const selectedVariantId =
    typeof bookingData.variantId ===
    "string"
      ? bookingData.variantId
      : "";

  if (!selectedVariantId) {
    return null;
  }

  return (
    normalizeServiceVariants(
      serviceNode.variants
    ).find(
      (variant) =>
        variant.id ===
        selectedVariantId
    ) ?? null
  );
};

export const calculateServicePrice = ({
  pricingType = "FIXED",
  basePrice,
  variantPrice,
  quantity,
  duration,
  pricingRules = [],
}: {
  pricingType?: ServicePricingType | null;
  basePrice?: number | null;
  variantPrice?: number | null;
  quantity?: number | null;
  duration?: number | null;
  pricingRules?: Array<{
    type: ServicePricingRuleType;
    baseRate: number;
  }>;
}) => {
  const normalizedPricingType =
    pricingType ?? "FIXED";
  const safeBasePrice =
    toOptionalNumber(basePrice) ?? 0;
  const safeVariantPrice =
    toOptionalNumber(variantPrice);
  const safeQuantity =
    toPositiveNumber(quantity);
  const safeDuration =
    toPositiveNumber(duration);

  if (
    normalizedPricingType ===
    "FIXED"
  ) {
    return roundMoney(safeBasePrice);
  }

  if (
    normalizedPricingType ===
    "CONSULTATION"
  ) {
    return roundMoney(
      safeVariantPrice ??
        safeBasePrice
    );
  }

  let total = 0;
  let hasDynamicComponent = false;

  if (safeVariantPrice != null) {
    total += safeVariantPrice;
    hasDynamicComponent = true;
  }

  for (const rule of pricingRules) {
    if (
      !Number.isFinite(
        rule.baseRate
      )
    ) {
      continue;
    }

    if (
      rule.type === "PER_HOUR"
    ) {
      if (safeDuration == null) {
        continue;
      }

      total +=
        rule.baseRate *
        safeDuration;
      hasDynamicComponent = true;
      continue;
    }

    if (safeQuantity == null) {
      continue;
    }

    total +=
      rule.baseRate *
      safeQuantity;
    hasDynamicComponent = true;
  }

  return roundMoney(
    hasDynamicComponent
      ? total
      : safeBasePrice
  );
};

const normalizeBookingFields = (
  bookingFields: unknown
): NormalizedBookingField[] => {
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

      const fieldRecord =
        field as Record<string, unknown>;
      const key =
        typeof fieldRecord.key ===
        "string"
          ? fieldRecord.key.trim()
          : "";

      if (!key) {
        return null;
      }

      const optionConfigs = Array.isArray(
        fieldRecord.optionConfigs
      )
        ? fieldRecord.optionConfigs
        : [];
      const legacyOptions =
        Array.isArray(fieldRecord.options)
          ? fieldRecord.options
          : [];

      const optionsSource =
        optionConfigs.length > 0
          ? optionConfigs
          : legacyOptions;

      const options = optionsSource
        .map((option) => {
          if (
            typeof option === "string"
          ) {
            const label =
              option.trim();

            if (!label) {
              return null;
            }

            return {
              label,
              price: null,
              pricingType: null,
            };
          }

          if (
            typeof option !== "object" ||
            option === null
          ) {
            return null;
          }

          const optionRecord =
            option as Record<
              string,
              unknown
            >;
          const label =
            typeof optionRecord.label ===
            "string"
              ? optionRecord.label.trim()
              : "";

          if (!label) {
            return null;
          }

          const pricingType =
            typeof optionRecord.pricingType ===
              "string" &&
            [
              "ADD",
              "OVERRIDE",
            ].includes(
              optionRecord.pricingType.toUpperCase()
            )
              ? (optionRecord.pricingType.toUpperCase() as ServiceBookingFieldOptionPricingType)
              : null;

          return {
            label,
            price: toOptionalNumber(
              optionRecord.price
            ),
            pricingType,
          };
        })
        .filter(
          (
            option
          ): option is NormalizedSelectOption =>
            option !== null
        );

      const booleanConfig = toRecord(
        fieldRecord.booleanConfig
      );

      const rawPricingRole =
        typeof fieldRecord.pricingRole ===
        "string"
          ? fieldRecord.pricingRole.toUpperCase()
          : null;

      const pricingRole =
        rawPricingRole === "AREA" ||
        rawPricingRole ===
          "DISTANCE" ||
        rawPricingRole ===
          "QUANTITY"
          ? (rawPricingRole as ServiceBookingFieldPricingRole)
          : null;

      return {
        key,
        type:
          typeof fieldRecord.type ===
          "string"
            ? fieldRecord.type
            : "",
        affectsPricing: Boolean(
          fieldRecord.affectsPricing
        ),
        pricingRole,
        options,
        booleanConfig:
          Object.keys(
            booleanConfig
          ).length > 0
            ? {
                truePrice:
                  toOptionalNumber(
                    booleanConfig.truePrice
                  ),
              }
            : null,
      };
    })
    .filter(
      (
        field
      ): field is NormalizedBookingField =>
        field !== null
    );
};

export const toBookingData = (
  value: unknown
): BookingData => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as BookingData;
};

export const toPositiveQuantity = (
  value: unknown,
  fallback = 1
) => {
  const parsed =
    typeof value === "number"
      ? value
      : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Math.ceil(fallback));
  }

  return Math.max(1, Math.ceil(parsed));
};

export const getPricingDrivenQuantity = (
  serviceNode: ServicePricingNode,
  bookingData: BookingData,
  fallbackQuantity: number
) => {
  const model =
    serviceNode.priceType ??
    "FIXED";
  const pricingRole =
    PRICING_ROLE_BY_MODEL[
      model as keyof typeof PRICING_ROLE_BY_MODEL
    ];

  if (!pricingRole) {
    return fallbackQuantity;
  }

  const pricingField =
    normalizeBookingFields(
      serviceNode.bookingFields
    ).find(
      (field) =>
        field.affectsPricing &&
        field.pricingRole ===
          pricingRole
    );

  if (!pricingField) {
    return fallbackQuantity;
  }

  return toPositiveQuantity(
    bookingData[pricingField.key],
    fallbackQuantity
  );
};

export const computeAdjustedUnitPrice = (
  basePrice: number,
  serviceNode: ServicePricingNode,
  bookingData: BookingData
) => {
  let resolvedPrice = basePrice;

  for (const field of normalizeBookingFields(
    serviceNode.bookingFields
  )) {
    if (
      !field.affectsPricing ||
      field.pricingRole
    ) {
      continue;
    }

    if (field.type === "select") {
      const selectedValue =
        typeof bookingData[field.key] ===
        "string"
          ? String(
              bookingData[field.key]
            ).trim()
          : "";

      if (!selectedValue) {
        continue;
      }

      const option = field.options.find(
        (item) =>
          item.label ===
          selectedValue
      );

      if (
        !option ||
        option.price == null
      ) {
        continue;
      }

      resolvedPrice =
        option.pricingType ===
        "OVERRIDE"
          ? option.price
          : resolvedPrice + option.price;

      continue;
    }

    if (
      field.type === "boolean" &&
      bookingData[field.key] === true &&
      field.booleanConfig
        ?.truePrice != null
    ) {
      resolvedPrice +=
        field.booleanConfig.truePrice;
    }
  }

  return resolvedPrice;
};

export const computeServiceLinePricing = ({
  basePrice,
  serviceNode,
  bookingData,
  fallbackQuantity,
}: {
  basePrice: number | null | undefined;
  serviceNode: ServicePricingNode;
  bookingData: BookingData;
  fallbackQuantity: number;
}) => {
  const normalizedPricingType =
    normalizeDynamicPricingType(
      serviceNode.pricingType
    );
  const isConsultationOnly =
    serviceNode.consultationOnly ===
      true ||
    normalizedPricingType ===
      "CONSULTATION";
  const normalizedPricingRules =
    normalizePricingRules(
      serviceNode.pricingRules
    );
  const selectedVariant =
    resolveSelectedVariant(
      serviceNode,
      bookingData
    );

  const usesDynamicPricing =
    normalizedPricingType !== null ||
    normalizedPricingRules.length > 0 ||
    normalizeServiceVariants(
      serviceNode.variants
    ).length > 0;

  if (isConsultationOnly) {
    const consultationUnitPrice =
      calculateServicePrice({
        pricingType:
          "CONSULTATION",
        basePrice:
          typeof basePrice ===
            "number" &&
          Number.isFinite(basePrice)
            ? basePrice
            : 0,
        variantPrice:
          selectedVariant?.price ??
          null,
      });

    return {
      quantity: 1,
      unitPrice:
        consultationUnitPrice,
      lineTotal:
        consultationUnitPrice,
      selectedVariantId:
        selectedVariant?.id ??
        null,
      pricingQuantity: null,
      duration: null,
    };
  }

  if (usesDynamicPricing) {
    const bookingCount =
      serviceNode.bookingMode ===
      "SINGLE"
        ? 1
        : toPositiveQuantity(
            fallbackQuantity,
            1
          );
    const pricingQuantity =
      resolvePricingQuantityInput({
        bookingData,
        fallbackQuantity,
        pricingRules:
          normalizedPricingRules,
      });
    const duration =
      resolveDurationInput({
        bookingData,
        serviceNode,
        pricingRules:
          normalizedPricingRules,
      });

    const singleBookingTotal =
      calculateServicePrice({
        pricingType:
          normalizedPricingType ??
          "VARIABLE",
        basePrice:
          typeof basePrice ===
            "number" &&
          Number.isFinite(basePrice)
            ? basePrice
            : 0,
        variantPrice:
          selectedVariant?.price ??
          null,
        quantity:
          pricingQuantity,
        duration,
        pricingRules:
          normalizedPricingRules,
      });

    const lineTotal =
      roundMoney(
        singleBookingTotal *
          bookingCount
      );

    return {
      quantity: bookingCount,
      unitPrice:
        singleBookingTotal,
      lineTotal,
      selectedVariantId:
        selectedVariant?.id ??
        null,
      pricingQuantity,
      duration,
    };
  }

  if (
    typeof basePrice !== "number" ||
    !Number.isFinite(basePrice)
  ) {
    throw new AppError(
      "Service price not configured",
      400
    );
  }

  const computedQuantity =
    getPricingDrivenQuantity(
      serviceNode,
      bookingData,
      fallbackQuantity
    );

  const quantity =
    serviceNode.bookingMode ===
    "SINGLE"
      ? 1
      : computedQuantity;

  const unitPrice =
    computeAdjustedUnitPrice(
      basePrice,
      serviceNode,
      bookingData
    );

  return {
    quantity,
    unitPrice,
    lineTotal: unitPrice * quantity,
  };
};
