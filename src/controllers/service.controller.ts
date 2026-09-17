// src/controllers/service.controller.ts

import { Request, Response } from "express";
import {
  PricingRuleType,
  Prisma,
  ServiceBookingMode,
  ServiceDurationType,
  ServicePriceType,
  ServicePricingType,
  ServiceType,
} from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";
import { getParam } from "../utils/request.util";
import { AuthRequest } from "../types/types";
import { resolveNodeMedia } from "../utils/media.util";
import { resolveServiceCapabilities } from "../resolvers/service.resolver";
import { calculateServicePrice } from "../utils/servicePricing.util";
import {
  moveServiceTreeToTrash,
} from "../services/trash.service";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const getId = (value: unknown) =>
  getParam(value, "id");

type ServiceFaqDraft = {
  question: string;
  answer: string;
  sortOrder: number;
  isActive: boolean;
};

type ServiceBookingFieldType =
  | "text"
  | "number"
  | "select"
  | "textarea"
  | "boolean"
  | "date"
  | "image_upload";

type ServiceBookingFieldPricingRole =
  | "AREA"
  | "DISTANCE"
  | "QUANTITY";

type ServiceBookingFieldOptionPricingType =
  | "ADD"
  | "OVERRIDE";

type ServiceBookingFieldOptionDraft = {
  label: string;
  description: string | null;
  price: number | null;
  pricingType: ServiceBookingFieldOptionPricingType | null;
};

type ServiceBookingFieldNumberConfigDraft = {
  min: number | null;
  max: number | null;
  step: number | null;
  defaultValue: number | null;
  unitLabel: string | null;
};

type ServiceBookingFieldBooleanConfigDraft = {
  trueLabel: string | null;
  falseLabel: string | null;
  truePrice: number | null;
};

type ServiceBookingFieldDraft = {
  key: string;
  label: string;
  type: ServiceBookingFieldType;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  options: string[];
  optionConfigs: ServiceBookingFieldOptionDraft[];
  affectsPricing: boolean;
  pricingRole: ServiceBookingFieldPricingRole | null;
  numberConfig: ServiceBookingFieldNumberConfigDraft | null;
  booleanConfig: ServiceBookingFieldBooleanConfigDraft | null;
};

type ServiceVariantDraft = {
  id?: string;
  name: string;
  price: number;
  sortOrder: number;
};

type PricingRuleDraft = {
  id?: string;
  type: PricingRuleType;
  baseRate: number;
  sortOrder: number;
};

const normalizeFaqDrafts = (
  value: unknown
): ServiceFaqDraft[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (
        typeof item !== "object" ||
        item === null
      ) {
        return null;
      }

      const question =
        typeof (item as any).question ===
          "string"
          ? (item as any).question.trim()
          : "";
      const answer =
        typeof (item as any).answer ===
          "string"
          ? (item as any).answer.trim()
          : "";

      if (!question || !answer) {
        return null;
      }

      const rawSortOrder = Number(
        (item as any).sortOrder ?? index
      );

      return {
        question,
        answer,
        sortOrder: Number.isFinite(
          rawSortOrder
        )
          ? rawSortOrder
          : index,
        isActive:
          typeof (item as any)
            .isActive === "boolean"
            ? (item as any).isActive
            : true,
      };
    })
    .filter(
      (
        faq
      ): faq is ServiceFaqDraft =>
        faq !== null
    );
};

const BOOKING_FIELD_TYPES =
  new Set<ServiceBookingFieldType>([
    "text",
    "number",
    "select",
    "textarea",
    "boolean",
    "date",
    "image_upload",
  ]);

const BOOKING_PRICING_ROLES =
  new Set<
    ServiceBookingFieldPricingRole
  >(["AREA", "DISTANCE", "QUANTITY"]);

const BOOKING_OPTION_PRICING_TYPES =
  new Set<
    ServiceBookingFieldOptionPricingType
  >(["ADD", "OVERRIDE"]);

const toNullableString = (
  value: unknown
) =>
  typeof value === "string"
    ? value.trim() || null
    : null;

const toNullableNumber = (
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

const normalizeBookingFields = (
  value: unknown
): ServiceBookingFieldDraft[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const usedKeys = new Set<string>();

  return value
    .map((field, index) => {
      if (
        typeof field !== "object" ||
        field === null
      ) {
        return null;
      }

      const rawKey =
        typeof (field as any).key ===
        "string"
          ? (field as any).key.trim()
          : "";
      const key = rawKey.replace(
        /[^a-zA-Z0-9_]/g,
        ""
      );
      const label =
        typeof (field as any).label ===
        "string"
          ? (field as any).label.trim()
          : "";
      const type =
        typeof (field as any).type ===
          "string" &&
        BOOKING_FIELD_TYPES.has(
          (field as any).type
        )
          ? ((field as any)
              .type as ServiceBookingFieldType)
          : null;

      if (!key || !label || !type) {
        return null;
      }

      if (usedKeys.has(key)) {
        throw new AppError(
          `Duplicate booking field key: ${key}`,
          400
        );
      }
      usedKeys.add(key);

      const options = Array.isArray(
        (field as any).options
      )
        ? ((field as any).options as unknown[])
            .filter(
              (option): option is string =>
                typeof option ===
                  "string" &&
                option.trim().length > 0
            )
            .map((option) =>
              option.trim()
            )
        : [];

      const optionConfigs = Array.isArray(
        (field as any).optionConfigs
      )
        ? ((field as any)
            .optionConfigs as unknown[])
            .map((option) => {
              if (
                typeof option !==
                  "object" ||
                option === null
              ) {
                return null;
              }

              const normalizedLabel =
                typeof (option as any)
                  .label ===
                "string"
                  ? (option as any)
                      .label
                      .trim()
                  : "";

              if (!normalizedLabel) {
                return null;
              }

              const pricingType =
                typeof (option as any)
                  .pricingType ===
                  "string" &&
                BOOKING_OPTION_PRICING_TYPES.has(
                  (option as any)
                    .pricingType
                    .toUpperCase()
                )
                  ? ((option as any)
                      .pricingType
                      .toUpperCase() as ServiceBookingFieldOptionPricingType)
                  : null;

              return {
                label: normalizedLabel,
                description:
                  toNullableString(
                    (option as any)
                      .description
                  ),
                price:
                  toNullableNumber(
                    (option as any)
                      .price
                  ),
                pricingType,
              };
            })
            .filter(
              (
                option
              ): option is ServiceBookingFieldOptionDraft =>
                option !== null
            )
        : options.map((option) => ({
            label: option,
            description: null,
            price: null,
            pricingType: null,
          }));

      const optionLabels =
        optionConfigs.map(
          (option) => option.label
        );

      if (
        new Set(optionLabels).size !==
        optionLabels.length
      ) {
        throw new AppError(
          `Select field "${label}" contains duplicate options`,
          400
        );
      }

      if (
        type === "select" &&
        optionConfigs.length === 0
      ) {
        throw new AppError(
          `Select field "${label}" must include options`,
          400
        );
      }

      const rawPricingRole =
        typeof (field as any)
          .pricingRole === "string"
          ? (
              field as any
            ).pricingRole.toUpperCase()
          : null;

      const pricingRole =
        rawPricingRole &&
        BOOKING_PRICING_ROLES.has(
          rawPricingRole as ServiceBookingFieldPricingRole
        )
          ? (rawPricingRole as ServiceBookingFieldPricingRole)
          : null;

      if (
        pricingRole &&
        type !== "number"
      ) {
        throw new AppError(
          `Pricing role can only be assigned to number fields. "${label}" is ${type}.`,
          400
        );
      }

      const rawNumberConfig =
        typeof (field as any)
          .numberConfig === "object" &&
        (field as any).numberConfig !==
          null
          ? ((field as any)
              .numberConfig as Record<
              string,
              unknown
            >)
          : null;

      const numberConfig =
        rawNumberConfig &&
        type === "number"
          ? {
              min: toNullableNumber(
                rawNumberConfig.min
              ),
              max: toNullableNumber(
                rawNumberConfig.max
              ),
              step: toNullableNumber(
                rawNumberConfig.step
              ),
              defaultValue:
                toNullableNumber(
                  rawNumberConfig.defaultValue
                ),
              unitLabel:
                toNullableString(
                  rawNumberConfig.unitLabel
                ),
            }
          : null;

      const rawBooleanConfig =
        typeof (field as any)
          .booleanConfig ===
          "object" &&
        (field as any)
          .booleanConfig !== null
          ? ((field as any)
              .booleanConfig as Record<
              string,
              unknown
            >)
          : null;

      const booleanConfig =
        rawBooleanConfig &&
        type === "boolean"
          ? {
              trueLabel:
                toNullableString(
                  rawBooleanConfig.trueLabel
                ),
              falseLabel:
                toNullableString(
                  rawBooleanConfig.falseLabel
                ),
              truePrice:
                toNullableNumber(
                  rawBooleanConfig.truePrice
                ),
            }
          : null;

      const hasOptionPricing =
        optionConfigs.some(
          (option) =>
            option.price !== null
        );
      const hasBooleanPricing =
        booleanConfig?.truePrice !=
        null;

      const affectsPricing =
        typeof (field as any)
          .affectsPricing ===
          "boolean"
          ? (field as any)
              .affectsPricing
          : pricingRole !== null ||
            hasOptionPricing ||
            hasBooleanPricing;

      return {
        key,
        label,
        type,
        required:
          typeof (field as any)
            .required === "boolean"
            ? (field as any).required
            : false,
        placeholder:
          typeof (field as any)
            .placeholder === "string"
            ? (field as any)
                .placeholder
            : null,
        helpText:
          typeof (field as any)
            .helpText === "string"
            ? (field as any).helpText
            : null,
        options: optionLabels,
        optionConfigs,
        affectsPricing,
        pricingRole,
        numberConfig,
        booleanConfig,
      };
    })
    .filter(
      (
        field
      ): field is ServiceBookingFieldDraft =>
        field !== null
    );
};

const assertManagedBranchAccess = async (
  req: AuthRequest,
  branchId: string
) => {
  if (!req.user) {
    throw new AppError(
      "Unauthorized",
      401
    );
  }

  const branch =
    await prisma.branch.findFirst({
      where: {
        id: branchId,
        deletedAt: null,
      },
      select: { id: true },
    });

  if (!branch) {
    throw new AppError(
      "Branch not found",
      404
    );
  }

  if (
    req.user.role === "SUPER_ADMIN"
  ) {
    return;
  }

  const admin =
    await prisma.branchAdmin.findFirst({
      where: {
        userId: req.user.id,
        branchId,
      },
      select: {
        branchId: true,
      },
    });

  if (!admin) {
    throw new AppError(
      "Unauthorized branch access",
      403
    );
  }
};

const normalizeBranchServicePrice = (
  value: unknown
) => {
  if (
    typeof value === "undefined" ||
    value === null ||
    (typeof value === "string" &&
      !value.trim())
  ) {
    return null;
  }

  if (
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    throw new AppError(
      "Price must be a number (0 or more)",
      400
    );
  }

  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    throw new AppError(
      "Price must be a number (0 or more)",
      400
    );
  }

  return parsed;
};

const collectServiceNodeSubtreeIds = (
  nodes: Array<{
    id: string;
    parentId: string | null;
  }>,
  rootId: string
) => {
  const childrenByParent = new Map<
    string,
    string[]
  >();

  nodes.forEach((node) => {
    if (!node.parentId) {
      return;
    }

    const siblings =
      childrenByParent.get(
        node.parentId
      ) ?? [];
    siblings.push(node.id);
    childrenByParent.set(
      node.parentId,
      siblings
    );
  });

  const subtreeIds = new Set<string>();
  const stack = [rootId];

  while (stack.length) {
    const current = stack.pop();

    if (!current) {
      continue;
    }

    if (subtreeIds.has(current)) {
      continue;
    }

    subtreeIds.add(current);

    const children =
      childrenByParent.get(current) ??
      [];

    if (children.length) {
      stack.push(...children);
    }
  }

  return subtreeIds;
};

const SERVICE_PRICE_TYPES = new Set<
  ServicePriceType
>([
  "FIXED",
  "STARTING_AT",
  "INSPECTION",
  "TIME_BASED",
  "AREA_BASED",
  "DISTANCE_BASED",
  "PACKAGE_BASED",
  "QUANTITY_BASED",
  "VARIANT_BASED",
  "CUSTOM_QUOTE",
]);

const SERVICE_PRICING_TYPES =
  new Set<ServicePricingType>([
    "FIXED",
    "VARIABLE",
    "CONSULTATION",
  ]);

const SERVICE_DURATION_TYPES =
  new Set<ServiceDurationType>([
    "FIXED",
    "FLEXIBLE",
  ]);

const SERVICE_DYNAMIC_PRICING_RULE_TYPES =
  new Set<PricingRuleType>([
    "PER_HOUR",
    "PER_UNIT",
    "PER_PERSON",
    "PER_SQFT",
  ]);

const SERVICE_TYPES = new Set<
  ServiceType
>([
  "CATEGORY",
  "GROUP",
  "SERVICE",
]);

const SERVICE_BOOKING_MODES =
  new Set<ServiceBookingMode>([
    "MULTI",
    "SINGLE",
  ]);

const normalizeServiceType = (
  type: unknown
): ServiceType => {
  if (typeof type !== "string") {
    throw new AppError(
      "Invalid service type",
      400
    );
  }

  if (
    !SERVICE_TYPES.has(
      type as ServiceType
    )
  ) {
    throw new AppError(
      "Unsupported service type",
      400
    );
  }

  return type as ServiceType;
};

const normalizeBookingMode = (
  mode: unknown
): ServiceBookingMode | undefined => {
  if (
    mode === undefined ||
    mode === null ||
    mode === ""
  ) {
    return undefined;
  }

  if (typeof mode !== "string") {
    throw new AppError(
      "Invalid bookingMode",
      400
    );
  }

  if (
    !SERVICE_BOOKING_MODES.has(
      mode as ServiceBookingMode
    )
  ) {
    throw new AppError(
      "Unsupported bookingMode",
      400
    );
  }

  return mode as ServiceBookingMode;
};

const normalizePriceType = (
  priceType: unknown
): ServicePriceType | undefined => {
  if (
    priceType === undefined ||
    priceType === null ||
    priceType === ""
  ) {
    return undefined;
  }

  if (typeof priceType !== "string") {
    throw new AppError(
      "Invalid priceType",
      400
    );
  }

  const normalized =
    priceType === "STARTING_FROM"
      ? "STARTING_AT"
      : priceType;

  if (
    !SERVICE_PRICE_TYPES.has(
      normalized as ServicePriceType
    )
  ) {
    throw new AppError(
      "Unsupported priceType",
      400
    );
  }

  return normalized as ServicePriceType;
};

const normalizeServicePricingType = (
  pricingType: unknown
): ServicePricingType | undefined => {
  if (
    pricingType === undefined ||
    pricingType === null ||
    pricingType === ""
  ) {
    return undefined;
  }

  if (typeof pricingType !== "string") {
    throw new AppError(
      "Invalid pricingType",
      400
    );
  }

  const normalized =
    pricingType.toUpperCase();

  if (
    !SERVICE_PRICING_TYPES.has(
      normalized as ServicePricingType
    )
  ) {
    throw new AppError(
      "Unsupported pricingType",
      400
    );
  }

  return normalized as ServicePricingType;
};

const normalizeServiceDurationType = (
  durationType: unknown
): ServiceDurationType | undefined => {
  if (
    durationType === undefined ||
    durationType === null ||
    durationType === ""
  ) {
    return undefined;
  }

  if (typeof durationType !== "string") {
    throw new AppError(
      "Invalid durationType",
      400
    );
  }

  const normalized =
    durationType.toUpperCase();

  if (
    !SERVICE_DURATION_TYPES.has(
      normalized as ServiceDurationType
    )
  ) {
    throw new AppError(
      "Unsupported durationType",
      400
    );
  }

  return normalized as ServiceDurationType;
};

const normalizeCancellationCutoffMinutes = (
  value: unknown
): number | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < 0
  ) {
    throw new AppError(
      "cancellationCutoffMinutes must be a whole number (0 or more)",
      400
    );
  }

  return parsed;
};

const normalizeServiceVariants = (
  value: unknown
): ServiceVariantDraft[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const usedNames = new Set<string>();
  const variants: ServiceVariantDraft[] = [];

  value.forEach((variant, index) => {
    if (
      typeof variant !== "object" ||
      variant === null
    ) {
      return;
    }

    const name =
      typeof (variant as any).name ===
      "string"
        ? (variant as any).name.trim()
        : "";
    const price = Number(
      (variant as any).price
    );
    const sortOrder = Number(
      (variant as any).sortOrder ??
        index
    );

    if (!name) {
      return;
    }

    if (
      !Number.isFinite(price) ||
      price < 0
    ) {
      throw new AppError(
        `Variant "${name}" requires a valid price`,
        400
      );
    }

    const duplicateKey =
      name.toLowerCase();

    if (
      usedNames.has(
        duplicateKey
      )
    ) {
      throw new AppError(
        `Duplicate service variant: ${name}`,
        400
      );
    }

    usedNames.add(
      duplicateKey
    );

    variants.push({
      id:
        typeof (variant as any).id ===
        "string"
          ? (variant as any).id
          : undefined,
      name,
      price,
      sortOrder:
        Number.isFinite(sortOrder)
          ? sortOrder
          : index,
    });
  });

  return variants;
};

const normalizePricingRules = (
  value: unknown
): PricingRuleDraft[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const rules: PricingRuleDraft[] = [];

  value.forEach((rule, index) => {
    if (
      typeof rule !== "object" ||
      rule === null
    ) {
      return;
    }

    const rawType =
      typeof (rule as any).type ===
      "string"
        ? (rule as any).type.toUpperCase()
        : "";
    const baseRate = Number(
      (rule as any).baseRate
    );
    const sortOrder = Number(
      (rule as any).sortOrder ??
        index
    );

    if (
      !SERVICE_DYNAMIC_PRICING_RULE_TYPES.has(
        rawType as PricingRuleType
      )
    ) {
      throw new AppError(
        "Unsupported pricing rule type",
        400
      );
    }

    if (
      !Number.isFinite(baseRate) ||
      baseRate < 0
    ) {
      throw new AppError(
        `Pricing rule "${rawType}" requires a valid baseRate`,
        400
      );
    }

    rules.push({
      id:
        typeof (rule as any).id ===
        "string"
          ? (rule as any).id
          : undefined,
      type:
        rawType as PricingRuleType,
      baseRate,
      sortOrder:
        Number.isFinite(sortOrder)
          ? sortOrder
          : index,
    });
  });

  return rules;
};

const deriveLegacyPriceType = ({
  explicitPriceType,
  pricingType,
  consultationOnly,
  variants,
  pricingRules,
}: {
  explicitPriceType?: ServicePriceType | null;
  pricingType?: ServicePricingType | null;
  consultationOnly?: boolean;
  variants: ServiceVariantDraft[];
  pricingRules: PricingRuleDraft[];
}) => {
  if (explicitPriceType) {
    return explicitPriceType;
  }

  if (
    consultationOnly ||
    pricingType === "CONSULTATION"
  ) {
    return "INSPECTION";
  }

  if (
    pricingRules.some(
      (rule) =>
        rule.type === "PER_HOUR"
    )
  ) {
    return "TIME_BASED";
  }

  if (
    pricingRules.some(
      (rule) =>
        rule.type === "PER_SQFT"
    )
  ) {
    return "AREA_BASED";
  }

  if (
    pricingRules.some(
      (rule) =>
        rule.type ===
          "PER_PERSON" ||
        rule.type === "PER_UNIT"
    )
  ) {
    return "QUANTITY_BASED";
  }

  if (variants.length > 0) {
    return "VARIANT_BASED";
  }

  if (pricingType === "VARIABLE") {
    return "STARTING_AT";
  }

  return "FIXED";
};

const normalizeServiceSlug = (
  slug: unknown
) => {
  if (typeof slug !== "string") {
    return "";
  }

  return slug.trim().toLowerCase();
};

const normalizeServiceName = (
  name: unknown
) => {
  if (typeof name !== "string") {
    return "";
  }

  return name.trim();
};

const resolveUniqueServiceSlug = async (
  rawSlug: string,
  excludeId?: string
) => {
  const slug = rawSlug.trim().toLowerCase();

  if (!slug) {
    return "";
  }

  const existingNodes =
    await prisma.serviceNode.findMany({
      where: {
        ...(excludeId
          ? {
              NOT: {
                id: excludeId,
              },
            }
          : {}),
        OR: [
          { slug },
          {
            slug: {
              startsWith: `${slug}-`,
            },
          },
        ],
      },
      select: {
        slug: true,
      },
    });

  const usedSlugs = new Set(
    existingNodes.map((node) => node.slug)
  );

  if (!usedSlugs.has(slug)) {
    return slug;
  }

  let suffix = 1;

  while (
    usedSlugs.has(`${slug}-${suffix}`)
  ) {
    suffix += 1;
  }

  return `${slug}-${suffix}`;
};

const normalizePublicServiceNode = <
  T extends {
    isBookable?: boolean | null;
    defaultPrice?: number | null;
    durationMinutes?: number | null;
  }
>(
  node: T,
  parent?: {
    isBookable?: boolean | null;
    defaultPrice?: number | null;
    durationMinutes?: number | null;
    parent?: unknown;
  } | null
) => {
  const resolved = resolveServiceCapabilities(
    parent ? ({ ...node, parent } as any) : (node as any)
  );

  return {
    ...node,
    ...resolved,
    isBookable: resolved.resolvedBookable,
    defaultPrice:
      node.defaultPrice ??
      resolved.resolvedPrice ??
      null,
    durationMinutes:
      node.durationMinutes ??
      resolved.resolvedDuration ??
      null,
  };
};

type ParentChainNode = {
  id: string;
  iconUrl?: string | null;
  coverUrl?: string | null;
  parent?: ParentChainNode | null;
};

const resolveParentChainMedia = async <
  T extends { parent?: ParentChainNode | null }
>(
  items: T[]
) => {
  const parentsById = new Map<
    string,
    ParentChainNode
  >();

  const collect = (
    node?: ParentChainNode | null
  ) => {
    if (
      !node?.id ||
      parentsById.has(node.id)
    ) {
      return;
    }

    parentsById.set(node.id, node);
    collect(node.parent ?? null);
  };

  items.forEach((item) =>
    collect(item.parent ?? null)
  );

  if (!parentsById.size) {
    return items;
  }

  const resolvedParents =
    await resolveNodeMedia(
      [...parentsById.values()]
    );

  const resolvedById = new Map(
    resolvedParents.map((node) => [
      node.id,
      node,
    ])
  );

  const rebuild = (
    node?: ParentChainNode | null
  ): ParentChainNode | null => {
    if (!node?.id) {
      return null;
    }

    const resolved =
      resolvedById.get(node.id) ?? node;

    return {
      ...resolved,
      parent: rebuild(
        node.parent ?? null
      ),
    };
  };

  return items.map((item) => ({
    ...item,
    parent: rebuild(
      item.parent ?? null
    ),
  }));
};

type NodeWithId = {
  id: string;
};

type ReviewSummary = {
  averageRating: number;
  totalReviews: number;
};

type BranchAwareNode = NodeWithId & {
  isBookable?: boolean | null;
  type?: string | null;
  defaultPrice?: number | null;
  resolvedPrice?: number | null;
};

const withBranchAvailability = async <
  T extends BranchAwareNode
>(
  nodes: T[],
  branchId?: string,
  options?: {
    filterUnavailableBookable?: boolean;
  }
) => {
  const filterUnavailableBookable =
    options?.filterUnavailableBookable ??
    true;

  if (!nodes.length) {
    return [] as Array<
      T & {
        isAvailableInBranch: boolean;
      }
    >;
  }

  if (!branchId) {
    return nodes.map((node) => ({
      ...node,
      isAvailableInBranch: true,
    }));
  }

  const branch =
    await prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        isActive: true,
      },
    });

  if (!branch || !branch.isActive) {
    throw new AppError(
      "Selected branch is not available",
      400
    );
  }

  const nodeIds = nodes.map(
    (node) => node.id
  );

  const branchServices =
    await prisma.branchService.findMany({
      where: {
        branchId,
        serviceNodeId: {
          in: nodeIds,
        },
        isActive: true,
      },
      select: {
        serviceNodeId: true,
        price: true,
      },
    });

  const availableIds = new Set(
    branchServices.map(
      (item) => item.serviceNodeId
    )
  );

  const priceByServiceId = new Map<
    string,
    number | null
  >(
    branchServices.map((row) => [
      row.serviceNodeId,
      row.price ?? null,
    ])
  );

  const withAvailability = nodes.map(
    (node) => {
      const isBookableNode =
        Boolean(node.isBookable) ||
        node.type === "SERVICE";
      const isAvailableInBranch =
        !isBookableNode ||
        availableIds.has(node.id);

      const branchPrice =
        priceByServiceId.get(node.id) ??
        null;

      const shouldOverridePrice =
        isBookableNode &&
        isAvailableInBranch &&
        typeof branchPrice === "number";

      return {
        ...node,
        isAvailableInBranch,
        branchPrice,
        ...(shouldOverridePrice
          ? {
              defaultPrice: branchPrice,
              resolvedPrice: branchPrice,
            }
          : {}),
      };
    }
  );

  return filterUnavailableBookable
    ? withAvailability.filter(
        (node) => node.isAvailableInBranch
      )
    : withAvailability;
};

const withReviewSummary = async <
  T extends NodeWithId
>(
  nodes: T[]
): Promise<Array<T & { reviewSummary: ReviewSummary }>> => {
  if (!nodes.length) {
    return [];
  }

  const ids = nodes.map((node) => node.id);

  const grouped =
    await prisma.serviceReview.groupBy({
      by: ["serviceNodeId"],
      where: {
        serviceNodeId: {
          in: ids,
        },
        isVisible: true,
      },
      _avg: {
        rating: true,
      },
      _count: {
        _all: true,
      },
    });

  const summaryMap = new Map<
    string,
    ReviewSummary
  >(
    grouped.map((row) => [
      row.serviceNodeId,
      {
        averageRating:
          row._avg.rating ?? 0,
        totalReviews:
          row._count._all,
      },
    ])
  );

  return nodes.map((node) => ({
    ...node,
    reviewSummary:
      summaryMap.get(node.id) ?? {
        averageRating: 0,
        totalReviews: 0,
      },
  }));
};

const isCatalogBookableNode = (
  node: {
    isBookable?: boolean | null;
    type?: string | null;
  }
) =>
  Boolean(node.isBookable) ||
  node.type === "SERVICE";

const getAvailableDescendantServiceCounts =
  async (
    rootIds: string[],
    branchId?: string
  ) => {
    if (rootIds.length === 0) {
      return new Map<string, number>();
    }

    const activeNodes =
      await prisma.serviceNode.findMany({
        where: {
          isActive: true,
        },
        select: {
          id: true,
          parentId: true,
          isBookable: true,
          type: true,
        },
      });

    const nodesById = new Map(
      activeNodes.map((node) => [
        node.id,
        node,
      ])
    );

    const childrenByParent =
      new Map<string, string[]>();

    activeNodes.forEach((node) => {
      childrenByParent.set(node.id, []);
    });

    activeNodes.forEach((node) => {
      if (!node.parentId) {
        return;
      }

      const children =
        childrenByParent.get(
          node.parentId
        ) ?? [];

      children.push(node.id);

      childrenByParent.set(
        node.parentId,
        children
      );
    });

    const availableIds = !branchId
      ? null
      : new Set(
          (
            await prisma.branchService.findMany(
              {
                where: {
                  branchId,
                  isActive: true,
                },
                select: {
                  serviceNodeId: true,
                },
              }
            )
          ).map((row) => row.serviceNodeId)
        );

    const countCache = new Map<
      string,
      number
    >();

    const countFrom = (
      nodeId: string
    ): number => {
      const cached =
        countCache.get(nodeId);

      if (typeof cached === "number") {
        return cached;
      }

      let count = 0;

      const childIds =
        childrenByParent.get(nodeId) ??
        [];

      childIds.forEach((childId) => {
        const child =
          nodesById.get(childId);

        if (!child) {
          return;
        }

        if (
          isCatalogBookableNode(child) &&
          (!availableIds ||
            availableIds.has(child.id))
        ) {
          count += 1;
        }

        count += countFrom(child.id);
      });

      countCache.set(nodeId, count);

      return count;
    };

    return new Map(
      rootIds.map((rootId) => [
        rootId,
        countFrom(rootId),
      ])
    );
  };

const getActiveDescendantIds = async (
  rootId: string
) => {
  const allNodes =
    await prisma.serviceNode.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        parentId: true,
      },
    });

  const childrenMap = new Map<
    string,
    string[]
  >();

  allNodes.forEach((node) => {
    childrenMap.set(node.id, []);
  });

  allNodes.forEach((node) => {
    if (!node.parentId) {
      return;
    }

    childrenMap.get(node.parentId)?.push(
      node.id
    );
  });

  const descendantIds: string[] = [];
  const stack = [
    ...(childrenMap.get(rootId) ?? []),
  ];

  while (stack.length) {
    const current = stack.shift();

    if (!current) {
      continue;
    }

    descendantIds.push(current);

    const children =
      childrenMap.get(current) ?? [];

    if (children.length > 0) {
      stack.push(...children);
    }
  }

  return descendantIds;
};

const buildNestedPublicTree = <
  T extends {
    id: string;
    parentId?: string | null;
  }
>(
  rootId: string,
  nodes: T[]
) => {
  const byId = new Map<
    string,
    T & { children: Array<T & { children: any[] }> }
  >();

  nodes.forEach((node) => {
    byId.set(node.id, {
      ...node,
      children: [],
    });
  });

  const roots: Array<
    T & { children: Array<T & { children: any[] }> }
  > = [];

  nodes.forEach((node) => {
    const current = byId.get(node.id);

    if (!current) {
      return;
    }

    if (node.parentId === rootId) {
      roots.push(current);
      return;
    }

    const parent = node.parentId
      ? byId.get(node.parentId)
      : undefined;

    if (parent) {
      parent.children.push(current);
    }
  });

  return roots;
};

const getNestedPublicChildren = async (
  rootId: string,
  branchId?: string
) => {
  const descendantIds =
    await getActiveDescendantIds(rootId);

  if (descendantIds.length === 0) {
    return [];
  }

  const descendants =
    await prisma.serviceNode.findMany({
      where: {
        id: {
          in: descendantIds,
        },
        isActive: true,
      },
      include: {
        parent: {
          include: {
            parent: true,
          },
        },
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
      orderBy: [
        {
          sortOrder: "asc",
        },
        {
          createdAt: "asc",
        },
      ],
    });

  const withMedia =
    await resolveNodeMedia(descendants);
  const withResolvedParents =
    await resolveParentChainMedia(
      withMedia
    );

  const normalized =
    withResolvedParents.map((node) =>
      normalizePublicServiceNode(
        node,
        node.parent ?? undefined
      )
    );

  const branchAware =
    await withBranchAvailability(
      normalized,
      branchId
    );

  const reviewed =
    await withReviewSummary(branchAware);

  return buildNestedPublicTree(
    rootId,
    reviewed
  );
};

const getFlatPublicBookableChildren =
  async (
    rootId: string,
    branchId?: string
  ) => {
    const descendantIds =
      await getActiveDescendantIds(rootId);

    if (descendantIds.length === 0) {
      return [];
    }

    const descendants =
      await prisma.serviceNode.findMany({
        where: {
          id: {
            in: descendantIds,
          },
          isActive: true,
        },
        include: {
          parent: {
            include: {
              parent: true,
            },
          },
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
        orderBy: [
          {
            sortOrder: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
      });

    const withMedia =
      await resolveNodeMedia(descendants);
    const withResolvedParents =
      await resolveParentChainMedia(
        withMedia
      );

    const normalized =
      withResolvedParents
        .map((node) =>
          normalizePublicServiceNode(
            node,
            node.parent ?? undefined
          )
        )
        .filter((node) =>
          isCatalogBookableNode(node)
        );

    const branchAware =
      await withBranchAvailability(
        normalized,
        branchId
      );

    return withReviewSummary(
      branchAware
    );
  };

//////////////////////////////////////////////////////
// PUBLIC SERVICES
//////////////////////////////////////////////////////

export const getRootServices = catchAsync(
  async (req: Request, res: Response) => {
    const branchId =
      typeof req.query.branchId ===
      "string"
        ? req.query.branchId
        : undefined;

    const services = await prisma.serviceNode.findMany({
      where: {
        parentId: null,
        isActive: true,
      },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        type: true,
        description: true,
        iconUrl: true,
        coverUrl: true,
        isBookable: true,
        durationMinutes: true,
        durationType: true,
        defaultPrice: true,
        priceType: true,
        pricingType: true,
        cancellationCutoffMinutes: true,
        bookingMode: true,
        consultationOnly: true,
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
        sortOrder: true,
        isActive: true,
      },
    });

    const withMedia =
      await resolveNodeMedia(services);

    const normalized =
      withMedia.map((service) =>
        normalizePublicServiceNode(service)
      );
    const branchAware =
      await withBranchAvailability(
        normalized,
        branchId
      );
    const formatted =
      await withReviewSummary(
        branchAware
      );
    const serviceCountByRoot =
      await getAvailableDescendantServiceCounts(
        formatted.map(
          (service) => service.id
        ),
        branchId
      );

    const withServiceCounts =
      formatted.map((service) => ({
        ...service,
        serviceCount:
          serviceCountByRoot.get(
            service.id
          ) ?? 0,
      }));

    res.json(
      successResponse(
        withServiceCounts
      )
    );
  }
);

//////////////////////////////////////////////////////

export const getServiceChildren = catchAsync(
  async (req: Request, res: Response) => {
    const branchId =
      typeof req.query.branchId ===
      "string"
        ? req.query.branchId
        : undefined;
    const flattenBookable =
      req.query.flattenBookable ===
      "true";

    const id = getId(req.params.id);

    if (flattenBookable) {
      const descendants =
        await getFlatPublicBookableChildren(
          id,
          branchId
        );

      res.json(
        successResponse(
          descendants
        )
      );

      return;
    }

    const parent =
      await prisma.serviceNode.findUnique({
        where: { id },
        include: {
          parent: {
            include: {
              parent: true,
            },
          },
        },
      });

    const children =
      await prisma.serviceNode.findMany({
        where: {
          parentId: id,
          isActive: true,
        },
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
        orderBy: { sortOrder: "asc" },
      });

    const withMedia =
      await resolveNodeMedia(children);

    const normalized =
      withMedia.map((child) =>
        normalizePublicServiceNode(
          child,
          parent ?? undefined
        )
      );
    const branchAware =
      await withBranchAvailability(
        normalized,
        branchId
      );
    const resolved =
      await withReviewSummary(
        branchAware
      );

    res.json(successResponse(resolved));

  }
);

//////////////////////////////////////////////////////


const getPublicServiceDetailBy = async (
  where: Prisma.ServiceNodeWhereInput,
  branchId?: string
) => {
  const service =
    await prisma.serviceNode.findFirst({
      where: {
        ...where,
        isActive: true,
      },
      include: {
        parent: {
          include: {
            parent: true,
          },
        },
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
        gallery: {
          include: {
            media: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
      },
    });

  if (!service) {
    throw new AppError(
      "Service not found",
      404
    );
  }

  const resolvedService =
    (await resolveNodeMedia([service]))[0] ??
    null;

  const parent = service.parent
    ? (await resolveNodeMedia([
        service.parent,
      ]))[0] ?? null
    : null;

  const normalizedService =
    normalizePublicServiceNode(
      resolvedService ?? service
    );

  const [
    mainWithSummary,
    childrenWithSummary,
  ] = await Promise.all([
    withBranchAvailability(
      [normalizedService],
      branchId,
      {
        filterUnavailableBookable: false,
      }
    ).then((nodes) =>
      withReviewSummary(nodes)
    ),
    getNestedPublicChildren(
      service.id,
      branchId
    ),
  ]);

  const resolvedMain =
    mainWithSummary[0] ??
    ({
      ...normalizedService,
      reviewSummary: {
        averageRating: 0,
        totalReviews: 0,
      },
    } as typeof normalizedService & {
      reviewSummary: ReviewSummary;
    });

  return {
    ...resolvedService,
    ...resolvedMain,
    parent,
    children: childrenWithSummary,
  };
};

export const getServiceBySlug = catchAsync(
  async (req: Request, res: Response) => {
    const branchId =
      typeof req.query.branchId ===
      "string"
        ? req.query.branchId
        : undefined;

    //////////////////////////////////////////////////////
    // PARAM
    //////////////////////////////////////////////////////

    const slug = getParam(
      req.params.slug,
      "slug"
    );

    const detail =
      await getPublicServiceDetailBy(
        { slug },
        branchId
      );

    res.json(successResponse(detail));
    return;
/*

    //////////////////////////////////////////////////////
    // FETCH SERVICE
    //////////////////////////////////////////////////////

    const service =
      await prisma.serviceNode.findFirst({
        where: {
          slug,
          isActive: true,
        },
        include: {
          parent: {
            include: {
              parent: true,
            },
          },
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

          gallery: {
            include: {
              media: true,
            },
            orderBy: {
              sortOrder: "asc",
            },
          },
        },
      });

    if (!service)
      throw new AppError(
        "Service not found",
        404
      );

    //////////////////////////////////////////////////////
    // RESOLVE MAIN SERVICE MEDIA
    //////////////////////////////////////////////////////

    const resolvedService =
      (await resolveNodeMedia([service]))[0] ?? null;

    //////////////////////////////////////////////////////
    // RESOLVE PARENT MEDIA ✅ TS SAFE
    //////////////////////////////////////////////////////

    const parent = service.parent
      ? (await resolveNodeMedia([
          service.parent,
        ]))[0] ?? null
      : null;

    //////////////////////////////////////////////////////
    // FINAL RESPONSE
    //////////////////////////////////////////////////////

    const normalizedService =
      normalizePublicServiceNode(
        resolvedService ?? service
      );

    const [
      mainWithSummary,
      childrenWithSummary,
    ] = await Promise.all([
      withBranchAvailability(
        [normalizedService],
        branchId,
        {
          filterUnavailableBookable: false,
        }
      ).then((nodes) =>
        withReviewSummary(nodes)
      ),
      getNestedPublicChildren(
        service.id,
        branchId
      ),
    ]);

    const resolvedMain =
      mainWithSummary[0] ??
      ({
        ...normalizedService,
        reviewSummary: {
          averageRating: 0,
          totalReviews: 0,
        },
      } as typeof normalizedService & {
        reviewSummary: ReviewSummary;
      });

res.json(
  successResponse({
    ...resolvedService,
    ...resolvedMain,
    parent,
    children: childrenWithSummary,
  })
);
*/
  }
);

export const getPublicServiceById =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {
      const branchId =
        typeof req.query.branchId ===
        "string"
          ? req.query.branchId
          : undefined;

      const id = getParam(
        req.params.id,
        "id"
      );

      const detail =
        await getPublicServiceDetailBy(
          { id },
          branchId
        );

      res.json(
        successResponse(detail)
      );
    }
  );

export const calculatePrice = catchAsync(
  async (req: Request, res: Response) => {
    const {
      serviceId,
      serviceNodeId,
      variantId,
      quantity,
      duration,
    } = req.body as {
      serviceId?: string;
      serviceNodeId?: string;
      variantId?: string;
      quantity?: number;
      duration?: number;
    };

    const resolvedServiceId =
      serviceId ?? serviceNodeId;

    if (!resolvedServiceId) {
      throw new AppError(
        "serviceId is required",
        400
      );
    }

    const service =
      await prisma.serviceNode.findUnique({
        where: {
          id: resolvedServiceId,
        },
        select: {
          id: true,
          isBookable: true,
          defaultPrice: true,
          pricingType: true,
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
      });

    if (!service) {
      throw new AppError(
        "Service not found",
        404
      );
    }

    if (!service.isBookable) {
      throw new AppError(
        "Only bookable services support dynamic pricing",
        400
      );
    }

    const selectedVariant =
      variantId
        ? service.variants.find(
            (variant) =>
              variant.id ===
              variantId
          ) ?? null
        : null;

    if (variantId && !selectedVariant) {
      throw new AppError(
        "Selected variant is invalid for this service",
        400
      );
    }

    const totalPrice =
      calculateServicePrice({
        pricingType:
          service.pricingType,
        basePrice:
          service.defaultPrice,
        variantPrice:
          selectedVariant?.price ??
          null,
        quantity:
          typeof quantity ===
            "number" &&
          Number.isFinite(quantity)
            ? quantity
            : null,
        duration:
          typeof duration ===
            "number" &&
          Number.isFinite(duration)
            ? duration
            : null,
        pricingRules:
          service.pricingRules.map(
            (rule) => ({
              type: rule.type,
              baseRate:
                rule.baseRate,
            })
          ),
      });

    res.json(
      successResponse(
        {
          totalPrice,
          variant: selectedVariant
            ? {
                id: selectedVariant.id,
                name: selectedVariant.name,
                price: selectedVariant.price,
              }
            : null,
        },
        "Price calculated"
      )
    );
  }
);
//////////////////////////////////////////////////////
// ADMIN TREE
//////////////////////////////////////////////////////

export const adminGetTree = catchAsync(
  async (req: Request, res: Response) => {
    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );
    res.setHeader("Pragma", "no-cache");

    const includeInactiveRaw =
      String(req.query.includeInactive ?? "true").toLowerCase();
    const includeInactive =
      includeInactiveRaw === "true" ||
      includeInactiveRaw === "1" ||
      includeInactiveRaw === "yes";

    const nodes =
      await prisma.serviceNode.findMany({
        where: includeInactive
          ? { deletedAt: null }
          : {
              isActive: true,
              deletedAt: null,
            },
        orderBy: {
          sortOrder: "asc",
        },
      });

    res.json(successResponse(nodes));
  }
);

//////////////////////////////////////////////////////

export const reorderServiceNodes = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const orderedIdsRaw = req.body?.orderedIds;

    if (!Array.isArray(orderedIdsRaw) || !orderedIdsRaw.length) {
      throw new AppError(
        "orderedIds must be a non-empty array",
        400
      );
    }

    const orderedIds = orderedIdsRaw.map((value, index) =>
      getParam(value, `orderedIds[${index}]`)
    );

    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new AppError(
        "orderedIds contains duplicates",
        400
      );
    }

    const requestedParentId =
      req.body?.parentId === null ||
      req.body?.parentId === undefined
        ? null
        : getId(req.body.parentId);

    const nodes = await prisma.serviceNode.findMany({
      where: {
        id: {
          in: orderedIds,
        },
      },
      select: {
        id: true,
        parentId: true,
        name: true,
      },
    });

    if (nodes.length !== orderedIds.length) {
      throw new AppError(
        "One or more services could not be found",
        404
      );
    }

    const nodeMap = new Map(
      nodes.map((node) => [node.id, node])
    );

    const actualParentIds = new Set(
      nodes.map((node) => node.parentId ?? null)
    );

    if (actualParentIds.size !== 1) {
      throw new AppError(
        "Services can only be reordered within the same level",
        400
      );
    }

    const actualParentId =
      nodes[0]?.parentId ?? null;

    if (actualParentId !== requestedParentId) {
      throw new AppError(
        "The provided parent does not match the selected services",
        400
      );
    }

    const siblingCount =
      await prisma.serviceNode.count({
        where: {
          parentId: actualParentId,
        },
      });

    if (siblingCount !== orderedIds.length) {
      throw new AppError(
        "Reordering requires the full sibling list for this level",
        400
      );
    }

    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.serviceNode.update({
          where: { id },
          data: {
            sortOrder: index,
          },
        })
      )
    );

    const updatedNodes =
      await prisma.serviceNode.findMany({
        where: {
          id: {
            in: orderedIds,
          },
        },
        orderBy: {
          sortOrder: "asc",
        },
        select: {
          id: true,
          name: true,
          parentId: true,
          sortOrder: true,
        },
      });

    res.json(
      successResponse(
        {
          parentId: actualParentId,
          orderedIds,
          items: updatedNodes,
        },
        "Service order updated"
      )
    );
  }
);

//////////////////////////////////////////////////////

export const createServiceNode = catchAsync(
  async (req: AuthRequest, res: Response) => {

    const {
      name,
      slug,
      type,
      parentId,
      description,
      iconUrl,
      coverUrl,
      isBookable,
      durationMinutes,
      defaultPrice,
      priceType,
      pricingType,
      durationType,
      cancellationCutoffMinutes,
      bookingMode,
      consultationOnly,
      variants = [],
      pricingRules = [],
      bookingFields = [],
      sortOrder,
      gallery = [],
      faqs = [],
    } = req.body;

    const faqDrafts = normalizeFaqDrafts(
      faqs
    );
    const bookingFieldDrafts =
      normalizeBookingFields(
        bookingFields
      );

    const normalizedType =
      normalizeServiceType(type);
    const normalizedName =
      normalizeServiceName(name);
    const normalizedSlug =
      normalizeServiceSlug(slug);
    const normalizedBookingMode =
      normalizeBookingMode(
        bookingMode
      ) ?? "MULTI";
    const normalizedPricingType =
      normalizeServicePricingType(
        pricingType
      ) ?? "FIXED";
    const normalizedDurationType =
      normalizeServiceDurationType(
        durationType
      ) ?? "FIXED";
    const normalizedVariants =
      normalizeServiceVariants(
        variants
      );
    const normalizedPricingRules =
      normalizePricingRules(
        pricingRules
      );
    const normalizedCancellationCutoffMinutes =
      normalizeCancellationCutoffMinutes(
        cancellationCutoffMinutes
      ) ?? null;

    const normalizedConsultationOnly =
      typeof consultationOnly === "boolean"
        ? consultationOnly
        : false;
    const normalizedPriceType =
      deriveLegacyPriceType({
        explicitPriceType:
          normalizePriceType(
            priceType
          ) ?? null,
        pricingType:
          normalizedPricingType,
        consultationOnly:
          normalizedConsultationOnly,
        variants:
          normalizedVariants,
        pricingRules:
          normalizedPricingRules,
      });

    //////////////////////////////////////////////////////
    // VALIDATION
    //////////////////////////////////////////////////////

    if (!normalizedName || !normalizedSlug)
      throw new AppError(
        "Name & slug required",
        400
      );
    const resolvedSlug =
      await resolveUniqueServiceSlug(
        normalizedSlug
      );

    if (parentId) {
      const parent =
        await prisma.serviceNode.findUnique({
          where: { id: parentId },
        });

      if (!parent)
        throw new AppError(
          "Invalid parent service",
          400
        );
    }

    if (
      normalizedType !== "SERVICE" &&
      isBookable
    ) {
      throw new AppError(
        "Only SERVICE type nodes can be bookable",
        400
      );
    }

    if (isBookable) {
      if (
        !durationMinutes ||
        !normalizedPriceType
      )
        throw new AppError(
          "Bookable service requires duration & priceType",
          400
        );
    }

    if (
      normalizedPricingType ===
        "VARIABLE" &&
      !normalizedVariants.length &&
      !normalizedPricingRules.length &&
      defaultPrice == null
    ) {
      throw new AppError(
        "Variable pricing requires at least one variant, one pricing rule, or a default base price.",
        400
      );
    }

    if (normalizedConsultationOnly) {
      if (!isBookable) {
        throw new AppError(
          "Consultation-only services must be bookable",
          400
        );
      }

      if (normalizedBookingMode !== "SINGLE") {
        throw new AppError(
          "Consultation-only services must use SINGLE booking mode",
          400
        );
      }
    }

    const createData: Prisma.ServiceNodeUncheckedCreateInput = {
      name: normalizedName,
      slug: resolvedSlug,
      type: normalizedType,
      parentId: parentId ?? null,
      description:
        description ?? null,
      iconUrl: iconUrl ?? null,
      coverUrl: coverUrl ?? null,
      isBookable:
        typeof isBookable === "boolean"
          ? isBookable
          : false,
      bookingMode:
        normalizedBookingMode,
      consultationOnly: normalizedConsultationOnly,
      durationMinutes:
        isBookable
          ? durationMinutes ?? null
          : null,
      durationType:
        isBookable
          ? normalizedDurationType
          : "FIXED",
      defaultPrice:
        isBookable
          ? normalizedConsultationOnly
            ? 0
            : defaultPrice ?? null
          : null,
      priceType:
        isBookable
          ? normalizedPriceType ?? null
          : null,
      pricingType:
        isBookable
          ? normalizedConsultationOnly
            ? "CONSULTATION"
            : normalizedPricingType
          : "FIXED",
      cancellationCutoffMinutes:
        isBookable
          ? normalizedCancellationCutoffMinutes
          : null,
      bookingFields:
        bookingFieldDrafts as Prisma.InputJsonValue,
      sortOrder:
        typeof sortOrder === "number"
          ? sortOrder
          : 0,
    };

    //////////////////////////////////////////////////////
    // TRANSACTION ✅
    //////////////////////////////////////////////////////

    const node = await prisma.$transaction(
      async (tx) => {

        ////////////////////////////////////
        // CREATE SERVICE
        ////////////////////////////////////

        const created =
          await tx.serviceNode.create({
            data: createData,
          });

        if (
          normalizedVariants.length
        ) {
          await tx.serviceVariant.createMany({
            data: normalizedVariants.map(
              (variant) => ({
                serviceId:
                  created.id,
                name: variant.name,
                price: variant.price,
                sortOrder:
                  variant.sortOrder,
              })
            ),
          });
        }

        if (
          normalizedPricingRules.length
        ) {
          await tx.pricingRule.createMany({
            data: normalizedPricingRules.map(
              (rule) => ({
                serviceId:
                  created.id,
                type: rule.type,
                baseRate:
                  rule.baseRate,
                sortOrder:
                  rule.sortOrder,
              })
            ),
          });
        }

        ////////////////////////////////////
        // ADD GALLERY
        ////////////////////////////////////

        if (gallery.length) {
          await tx.serviceNodeMedia.createMany({
            data: gallery.map(
              (mediaId: string, index: number) => ({
                serviceNodeId: created.id,
                mediaId,
                sortOrder: index,
              })
            ),
          });
        }

        if (faqDrafts.length) {
          await tx.faq.createMany({
            data: faqDrafts.map(
              (faq) => ({
                serviceNodeId:
                  created.id,
                question:
                  faq.question,
                answer: faq.answer,
                sortOrder:
                  faq.sortOrder,
                isActive:
                  faq.isActive,
              })
            ),
          });
        }

        ////////////////////////////////////
        // ENABLE FOR ALL BRANCHES
        //
        // Public listings only surface SERVICE nodes that have an
        // active BranchService row (see withBranchAvailability). Without
        // this, every newly created service is invisible on the
        // storefront until an admin separately visits the Branch
        // Services panel for each branch. Default to available
        // everywhere; branch operators can still opt individual
        // branches out via that panel.
        ////////////////////////////////////

        if (normalizedType === "SERVICE") {
          const activeBranches =
            await tx.branch.findMany({
              where: { isActive: true },
              select: { id: true },
            });

          if (activeBranches.length) {
            await tx.branchService.createMany({
              data: activeBranches.map(
                (branch) => ({
                  branchId: branch.id,
                  serviceNodeId: created.id,
                })
              ),
              skipDuplicates: true,
            });
          }
        }

        return created;
      }
    );

    //////////////////////////////////////////////////////
    // RETURN WITH GALLERY
    //////////////////////////////////////////////////////

    const fullNode =
      await prisma.serviceNode.findUnique({
        where: { id: node.id },
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
          gallery: {
            include: { media: true },
            orderBy: { sortOrder: "asc" },
          },
          faqs: {
            orderBy: [
              {
                sortOrder: "asc",
              },
              {
                createdAt: "desc",
              },
            ],
          },
        },
      });

    res.json(
      successResponse(
        fullNode,
        resolvedSlug === normalizedSlug
          ? "Service created"
          : `Service created. Slug adjusted to ${resolvedSlug}`
      )
    );
  }
);

//////////////////////////////////////////////////////

export const updateServiceNode = catchAsync(
  async (req: AuthRequest, res: Response) => {

    const id = getId(req.params.id);

    const {
      gallery,
      faqs,
      bookingFields,
      variants,
      pricingRules,
      parentId,
      ...rest
    } = req.body;

    const faqDrafts = normalizeFaqDrafts(
      faqs
    );
    const bookingFieldDrafts =
      bookingFields !== undefined
        ? normalizeBookingFields(
            bookingFields
          )
        : undefined;
    const variantDrafts =
      variants !== undefined
        ? normalizeServiceVariants(
            variants
          )
        : undefined;
    const pricingRuleDrafts =
      pricingRules !== undefined
        ? normalizePricingRules(
            pricingRules
          )
        : undefined;

    const existingNode =
      await prisma.serviceNode.findUnique({
        where: { id },
        select: {
          id: true,
          isBookable: true,
          bookingMode: true,
          consultationOnly: true,
          durationMinutes: true,
          durationType: true,
          priceType: true,
          pricingType: true,
          defaultPrice: true,
          cancellationCutoffMinutes: true,
          variants: {
            select: {
              id: true,
              name: true,
              price: true,
              sortOrder: true,
            },
          },
          pricingRules: {
            select: {
              id: true,
              type: true,
              baseRate: true,
              sortOrder: true,
            },
          },
        },
      });

    if (!existingNode) {
      throw new AppError(
        "Service not found",
        404
      );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "name"
      )
    ) {
      const normalizedName =
        normalizeServiceName(rest.name);

      if (!normalizedName) {
        throw new AppError(
          "Name is required",
          400
        );
      }

      rest.name = normalizedName;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "slug"
      )
    ) {
      const normalizedSlug =
        normalizeServiceSlug(rest.slug);

      if (!normalizedSlug) {
        throw new AppError(
          "Slug is required",
          400
        );
      }

      rest.slug =
        await resolveUniqueServiceSlug(
          normalizedSlug,
          id
        );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "type"
      )
    ) {
      rest.type =
        normalizeServiceType(rest.type);
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "bookingMode"
      )
    ) {
      rest.bookingMode =
        normalizeBookingMode(
          rest.bookingMode
        );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "priceType"
      )
    ) {
      const normalizedPriceType =
        normalizePriceType(
          rest.priceType
        ) ?? null;

      rest.priceType =
        normalizedPriceType;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "pricingType"
      )
    ) {
      rest.pricingType =
        normalizeServicePricingType(
          rest.pricingType
        ) ?? null;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "cancellationCutoffMinutes"
      )
    ) {
      rest.cancellationCutoffMinutes =
        normalizeCancellationCutoffMinutes(
          rest.cancellationCutoffMinutes
        );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        rest,
        "durationType"
      )
    ) {
      rest.durationType =
        normalizeServiceDurationType(
          rest.durationType
        ) ?? null;
    }

    //////////////////////////////////////////////////////
    // BUILD UPDATE DATA ✅
    //////////////////////////////////////////////////////

    const data: any =
      Object.fromEntries(
        Object.entries(rest).filter(
          ([, value]) =>
            value !== undefined
        )
      );

    if (bookingFieldDrafts !== undefined) {
      data.bookingFields =
        bookingFieldDrafts as Prisma.InputJsonValue;
    }

    if (data.isBookable === false) {
      data.durationMinutes = null;
      data.durationType = "FIXED";
      data.defaultPrice = null;
      data.priceType = null;
      data.pricingType = "FIXED";
      data.cancellationCutoffMinutes =
        null;
    }

    const nextIsBookable =
      typeof data.isBookable ===
      "boolean"
        ? data.isBookable
        : existingNode.isBookable;
    const nextBookingMode =
      Object.prototype.hasOwnProperty.call(
        data,
        "bookingMode"
      )
        ? data.bookingMode
        : existingNode.bookingMode;
    const nextConsultationOnly =
      Object.prototype.hasOwnProperty.call(
        data,
        "consultationOnly"
      )
        ? Boolean(data.consultationOnly)
        : existingNode.consultationOnly;
    const nextDuration =
      Object.prototype.hasOwnProperty.call(
        data,
        "durationMinutes"
      )
        ? data.durationMinutes
        : existingNode.durationMinutes;
    const nextPricingType =
      nextConsultationOnly
        ? "CONSULTATION"
        : Object.prototype.hasOwnProperty.call(
            data,
            "pricingType"
          )
        ? data.pricingType
        : existingNode.pricingType;
    const nextVariants =
      variantDrafts ??
      existingNode.variants.map(
        (variant) => ({
          id: variant.id,
          name: variant.name,
          price: variant.price,
          sortOrder:
            variant.sortOrder,
        })
      );
    const nextPricingRules =
      pricingRuleDrafts ??
      existingNode.pricingRules.map(
        (rule) => ({
          id: rule.id,
          type: rule.type,
          baseRate:
            rule.baseRate,
          sortOrder:
            rule.sortOrder,
        })
      );
    const nextBasePrice =
      nextConsultationOnly
        ? 0
        : Object.prototype.hasOwnProperty.call(
            data,
            "defaultPrice"
          )
        ? data.defaultPrice
        : existingNode.defaultPrice;
    const nextPriceType =
      deriveLegacyPriceType({
        explicitPriceType:
          Object.prototype.hasOwnProperty.call(
            rest,
            "priceType"
          )
            ? data.priceType ?? null
            : existingNode.priceType,
        pricingType:
          nextPricingType,
        consultationOnly:
          nextConsultationOnly,
        variants:
          nextVariants,
        pricingRules:
          nextPricingRules,
      });

    data.priceType =
      nextIsBookable
        ? nextPriceType
        : null;

    if (nextConsultationOnly) {
      data.defaultPrice = 0;
      data.pricingType = "CONSULTATION";
    }

    if (
      nextIsBookable &&
      (!nextDuration ||
        !nextPriceType)
    ) {
      throw new AppError(
        "Bookable service requires duration & priceType",
        400
      );
    }

    if (
      nextPricingType ===
        "VARIABLE" &&
      !nextVariants.length &&
      !nextPricingRules.length &&
      (nextBasePrice == null ||
        !Number.isFinite(
          nextBasePrice
        ))
    ) {
      throw new AppError(
        "Variable pricing requires at least one variant, one pricing rule, or a default base price.",
        400
      );
    }

    if (nextConsultationOnly) {
      if (!nextIsBookable) {
        throw new AppError(
          "Consultation-only services must be bookable",
          400
        );
      }

      if (nextBookingMode !== "SINGLE") {
        throw new AppError(
          "Consultation-only services must use SINGLE booking mode",
          400
        );
      }
    }

    ////////////////////////////////////////////////
    // FIX RELATION UPDATE ⭐⭐⭐⭐⭐
    ////////////////////////////////////////////////

    if (parentId === null) {
      data.parent = {
        disconnect: true,
      };
    }

    if (parentId) {
      data.parent = {
        connect: { id: parentId },
      };
    }

    //////////////////////////////////////////////////////
    // TRANSACTION
    //////////////////////////////////////////////////////

    const node = await prisma.$transaction(
      async (tx) => {

        const updated =
          await tx.serviceNode.update({
            where: { id },
            data,
          });

        if (variantDrafts !== undefined) {
          await tx.serviceVariant.deleteMany({
            where: {
              serviceId: id,
            },
          });

          if (variantDrafts.length) {
            await tx.serviceVariant.createMany({
              data: variantDrafts.map(
                (variant) => ({
                  serviceId: id,
                  name: variant.name,
                  price: variant.price,
                  sortOrder:
                    variant.sortOrder,
                })
              ),
            });
          }
        }

        if (
          pricingRuleDrafts !== undefined
        ) {
          await tx.pricingRule.deleteMany({
            where: {
              serviceId: id,
            },
          });

          if (
            pricingRuleDrafts.length
          ) {
            await tx.pricingRule.createMany({
              data: pricingRuleDrafts.map(
                (rule) => ({
                  serviceId: id,
                  type: rule.type,
                  baseRate:
                    rule.baseRate,
                  sortOrder:
                    rule.sortOrder,
                })
              ),
            });
          }
        }

        ////////////////////////////////////
        // UPDATE GALLERY
        ////////////////////////////////////

        if (gallery) {

          await tx.serviceNodeMedia.deleteMany({
            where: { serviceNodeId: id },
          });

          if (gallery.length) {
            await tx.serviceNodeMedia.createMany({
              data: gallery.map(
                (mediaId: string, index: number) => ({
                  serviceNodeId: id,
                  mediaId,
                  sortOrder: index,
                })
              ),
            });
          }
        }

        if (faqs !== undefined) {
          await tx.faq.deleteMany({
            where: {
              serviceNodeId: id,
            },
          });

          if (faqDrafts.length) {
            await tx.faq.createMany({
              data: faqDrafts.map(
                (faq) => ({
                  serviceNodeId:
                    id,
                  question:
                    faq.question,
                  answer:
                    faq.answer,
                  sortOrder:
                    faq.sortOrder,
                  isActive:
                    faq.isActive,
                })
              ),
            });
          }
        }

        return updated;
      }
    );

    const full =
      await prisma.serviceNode.findUnique({
        where: { id },
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
          gallery: {
            include: { media: true },
            orderBy: { sortOrder: "asc" },
          },
          faqs: {
            orderBy: [
              {
                sortOrder: "asc",
              },
              {
                createdAt: "desc",
              },
            ],
          },
        },
      });

    res.json(
      successResponse(
        full,
        typeof data.slug === "string" &&
        data.slug !== normalizeServiceSlug(req.body.slug)
          ? `Service updated. Slug adjusted to ${data.slug}`
          : "Service updated"
      )
    );
  }
);

//////////////////////////////////////////////////////

export const deleteServiceNode = catchAsync(
  async (req: AuthRequest, res: Response) => {

    const id = getId(req.params.id);
    const result =
      await moveServiceTreeToTrash(id);

    res.json(
      successResponse(
        {
          deletedCount:
            result.deletedCount,
        },
        "Service moved to trash. It will be permanently deleted after 30 days unless restored."
      )
    );
  }
);

//////////////////////////////////////////////////////
// BRANCH SERVICES
//////////////////////////////////////////////////////

export const enableBranchService =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {

      const { branchId, serviceNodeId, price } =
        req.body;

      if (!branchId || !serviceNodeId)
        throw new AppError(
          "branchId & serviceNodeId required",
          400
        );

      await assertManagedBranchAccess(
        req,
        branchId
      );

      const service =
        await prisma.serviceNode.findUnique({
          where: { id: serviceNodeId },
        });

      if (
        !service ||
        !service.isBookable ||
        !service.isActive
      )
        throw new AppError(
          "Invalid or inactive service",
          400
        );

      const branchService =
        await prisma.branchService.upsert({
          where: {
            branchId_serviceNodeId: {
              branchId,
              serviceNodeId,
            },
          },
          update: {
            price:
              normalizeBranchServicePrice(
                price
              ),
            isActive: true,
          },
          create: {
            branchId,
            serviceNodeId,
            price:
              normalizeBranchServicePrice(
                price
              ),
          },
        });

      res.json(
        successResponse(
          branchService,
          "Service enabled"
        )
      );
    }
  );

//////////////////////////////////////////////////////

export const setBranchServiceNodeAvailability =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const { branchId, serviceNodeId, enabled } =
        req.body ?? {};

      if (!branchId || !serviceNodeId) {
        throw new AppError(
          "branchId & serviceNodeId required",
          400
        );
      }

      if (typeof enabled !== "boolean") {
        throw new AppError(
          "enabled must be a boolean",
          400
        );
      }

      const branch =
        await prisma.branch.findUnique({
          where: { id: branchId },
          select: {
            id: true,
            isActive: true,
          },
        });

      if (!branch) {
        throw new AppError(
          "Branch not found",
          404
        );
      }

      await assertManagedBranchAccess(
        req,
        branchId
      );

      const catalogNodes =
        await prisma.serviceNode.findMany({
          select: {
            id: true,
            parentId: true,
            isBookable: true,
            isActive: true,
            type: true,
          },
        });

      const targetNode =
        catalogNodes.find(
          (node) =>
            node.id === serviceNodeId
        ) ?? null;

      if (!targetNode) {
        throw new AppError(
          "Service node not found",
          404
        );
      }

      if (
        enabled &&
        !targetNode.isActive
      ) {
        throw new AppError(
          "Cannot enable services under an inactive catalog node",
          409
        );
      }

      const subtreeIds =
        collectServiceNodeSubtreeIds(
          catalogNodes,
          serviceNodeId
        );

      const allBookableDescendants =
        catalogNodes.filter(
          (node) =>
            subtreeIds.has(node.id) &&
            node.isBookable
        );

      const eligibleServiceIds =
        allBookableDescendants
          .filter(
            (node) =>
              !enabled || node.isActive
          )
          .map((node) => node.id);

      const skippedInactiveCount =
        enabled
          ? allBookableDescendants.filter(
              (node) => !node.isActive
            ).length
          : 0;

      const existingBranchServices =
        eligibleServiceIds.length
          ? await prisma.branchService.findMany({
              where: {
                branchId,
                serviceNodeId: {
                  in: eligibleServiceIds,
                },
              },
              select: {
                id: true,
                serviceNodeId: true,
                isActive: true,
              },
            })
          : [];

      let createdCount = 0;
      let reactivatedCount = 0;
      let deactivatedCount = 0;
      let alreadyMatchingCount = 0;

      await prisma.$transaction(
        async (tx) => {
          if (enabled) {
            const existingIds = new Set(
              existingBranchServices.map(
                (branchService) =>
                  branchService.serviceNodeId
              )
            );
            const existingServiceIds =
              existingBranchServices.map(
                (branchService) =>
                  branchService.serviceNodeId
              );

            reactivatedCount =
              existingBranchServices.filter(
                (branchService) =>
                  !branchService.isActive
              ).length;
            alreadyMatchingCount =
              existingBranchServices.length -
              reactivatedCount;

            if (existingServiceIds.length) {
              await tx.branchService.updateMany({
                where: {
                  branchId,
                  serviceNodeId: {
                    in: existingServiceIds,
                  },
                },
                data: {
                  isActive: true,
                },
              });
            }

            const missingServiceIds =
              eligibleServiceIds.filter(
                (id) =>
                  !existingIds.has(id)
              );

            if (missingServiceIds.length) {
              await tx.branchService.createMany({
                data: missingServiceIds.map(
                  (id) => ({
                    branchId,
                    serviceNodeId: id,
                  })
                ),
              });
              createdCount =
                missingServiceIds.length;
            }

            return;
          }

          const existingServiceIds =
            existingBranchServices.map(
              (branchService) =>
                branchService.serviceNodeId
            );

          deactivatedCount =
            existingBranchServices.filter(
              (branchService) =>
                branchService.isActive
            ).length;
          alreadyMatchingCount =
            existingBranchServices.length -
            deactivatedCount;

          if (existingServiceIds.length) {
            await tx.branchService.updateMany({
              where: {
                branchId,
                serviceNodeId: {
                  in: existingServiceIds,
                },
              },
              data: {
                isActive: false,
              },
            });
          }
        }
      );

      const affectedCount = enabled
        ? createdCount +
          reactivatedCount
        : deactivatedCount;

      res.json(
        successResponse(
          {
            branchId,
            serviceNodeId,
            enabled,
            branchIsActive:
              branch.isActive,
            targetNodeType:
              targetNode.type,
            totalDescendantServices:
              allBookableDescendants.length,
            eligibleServiceCount:
              eligibleServiceIds.length,
            affectedCount,
            createdCount,
            reactivatedCount,
            deactivatedCount,
            alreadyMatchingCount,
            skippedInactiveCount,
          },
          enabled
            ? "Branch services enabled"
            : "Branch services disabled"
        )
      );
    }
  );

//////////////////////////////////////////////////////

export const updateBranchService =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {

      const id = getId(req.params.id);

      const branchService =
        await prisma.branchService.findUnique({
          where: { id },
        });

      if (!branchService)
        throw new AppError(
          "Service not found",
          404
        );

      await assertManagedBranchAccess(
        req,
        branchService.branchId
      );

      if (
        !Object.prototype.hasOwnProperty.call(
          req.body ?? {},
          "price"
        )
      ) {
        throw new AppError(
          "price is required",
          400
        );
      }

      const updated =
        await prisma.branchService.update({
          where: { id },
          data: {
            price:
              normalizeBranchServicePrice(
                req.body.price
              ),
          },
        });

      res.json(
        successResponse(
          updated,
          "Branch service updated"
        )
      );
    }
  );

//////////////////////////////////////////////////////

export const disableBranchService =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {

      const id = getId(req.params.id);

      const branchService =
        await prisma.branchService.findUnique({
          where: { id },
        });

      if (!branchService)
        throw new AppError(
          "Service not found",
          404
        );

      await assertManagedBranchAccess(
        req,
        branchService.branchId
      );

      await prisma.branchService.update({
        where: { id },
        data: { isActive: false },
      });

      res.json(
        successResponse(
          null,
          "Service disabled"
        )
      );
    }
  );

//////////////////////////////////////////////////////
// BRANCH SERVICE AVAILABILITY (DASHBOARD)
//////////////////////////////////////////////////////

export const listBranchServiceAvailability =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      const branchId = getParam(
        req.query.branchId,
        "branchId"
      );
      const includeInactive =
        req.query.includeInactive ===
        "true";

      const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: { id: true, isActive: true },
      });

      if (!branch)
        throw new AppError(
          "Branch not found",
          404
        );

      await assertManagedBranchAccess(
        req,
        branchId
      );

      const services =
        await prisma.serviceNode.findMany({
          ...(!includeInactive
            ? {
                where: {
                  isActive: true,
                },
              }
            : {}),
          include: {
            parent: {
              include: {
                parent: true,
              },
            },
            branchServices: {
              where: {
                branchId,
              },
              select: {
                id: true,
                price: true,
                isActive: true,
                serviceNodeId: true,
                branchId: true,
                createdAt: true,
              },
              take: 1,
            },
          },
          orderBy: [
            {
              sortOrder: "asc",
            },
            {
              createdAt: "asc",
            },
          ],
        });

      const formatted = services.map((s) => {
        const bs = s.branchServices[0] ?? null;

        return {
          serviceNode: {
            id: s.id,
            name: s.name,
            slug: s.slug,
            type: s.type,
            parentId: s.parentId,
            categoryPath: [
              s.parent?.parent?.name,
              s.parent?.name,
            ]
              .filter(Boolean)
              .join(" > "),
            sortOrder: s.sortOrder,
            isActive: s.isActive,
            isBookable: s.isBookable,
            durationMinutes: s.durationMinutes,
            defaultPrice: s.defaultPrice,
            priceType: s.priceType,
            bookingMode: s.bookingMode,
            consultationOnly:
              s.consultationOnly,
          },
          branchService: bs
            ? {
                id: bs.id,
                branchId: bs.branchId,
                serviceNodeId: bs.serviceNodeId,
                price: bs.price,
                isActive: bs.isActive,
                createdAt: bs.createdAt,
              }
            : null,
          enabled:
            !!bs &&
            bs.isActive,
          branchIsActive: branch.isActive,
        };
      });

      res.json(
        successResponse(
          formatted,
          "Branch service availability fetched"
        )
      );
    }
  );

//////////////////////////////////////////////////////
// ADMIN FLAT SERVICES (BOOKABLE ONLY)
//////////////////////////////////////////////////////

export const adminListServices = catchAsync(
  async (_req: Request, res: Response) => {

    const services =
      await prisma.serviceNode.findMany({
        where: {
          isBookable: true,
          isActive: true,
          deletedAt: null,
        },
        include: {
          parent: {
            include: {
              parent: true,
            },
          },
          gallery: {
            take: 1,
            include: {
              media: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    const formatted = services.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      duration: s.durationMinutes,
      basePrice: s.defaultPrice,
      priceType: s.priceType,
      bookingMode: s.bookingMode,
      isActive: s.isActive,

      categoryPath: [
        s.parent?.parent?.name,
        s.parent?.name,
      ]
        .filter(Boolean)
        .join(" > "),

      coverMedia:
        s.gallery[0]?.media || null,
    }));

    res.json(successResponse(formatted));
  }
);

export const adminGetServiceById = catchAsync(
async (req: Request, res: Response) => {

const id = getId(req.params.id);

//////////////////////////////////////////////////
// FETCH SERVICE
//////////////////////////////////////////////////

const service =
await prisma.serviceNode.findUnique({
where: { id },

include: {
parent: true,
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
faqs: {
orderBy: [
{
sortOrder: "asc",
},
{
createdAt: "desc",
},
],
},

gallery: {
include: { media: true },
orderBy: { sortOrder: "asc" },
},

children: {
where: { isActive: true },

include: {
gallery: {
take: 1,
include: {
media: true,
},
},
},

orderBy: {
sortOrder: "asc",
},
},
},
});

if (!service)
throw new AppError(
"Service not found",
404
);

//////////////////////////////////////////////////
// ⭐ COLLECT ALL MEDIA IDS
//////////////////////////////////////////////////

const mediaIds = new Set<string>();

// parent
if (service.iconUrl)
mediaIds.add(service.iconUrl);

if (service.coverUrl)
mediaIds.add(service.coverUrl);

// children
service.children.forEach(child => {
if (child.iconUrl)
mediaIds.add(child.iconUrl);

if (child.coverUrl)
mediaIds.add(child.coverUrl);
});

//////////////////////////////////////////////////
// FETCH MEDIA ONCE ✅
//////////////////////////////////////////////////

let mediaMap: Record<string,string> = {};

if (mediaIds.size) {

const medias =
await prisma.media.findMany({
where: {
id: {
in: [...mediaIds],
},
},
select: {
id: true,
url: true,
},
});

mediaMap = Object.fromEntries(
medias.map(m => [m.id, m.url])
);
}

//////////////////////////////////////////////////
// ⭐ TRANSFORM CHILDREN
//////////////////////////////////////////////////

const children = service.children.map(child => ({
...child,

iconMediaId: child.iconUrl ?? null,
coverMediaId: child.coverUrl ?? null,

iconUrl:
child.iconUrl
? mediaMap[child.iconUrl] ?? null
: null,

coverUrl:
child.coverUrl
? mediaMap[child.coverUrl] ?? null
: null,
}));

//////////////////////////////////////////////////
// ⭐ FINAL RESPONSE
//////////////////////////////////////////////////
const formattedService = {
  ...service,

  ...resolveServiceCapabilities(service),

  iconMediaId: service.iconUrl ?? null,
  coverMediaId: service.coverUrl ?? null,

  iconUrl:
    service.iconUrl
      ? mediaMap[service.iconUrl] ?? null
      : null,

  coverUrl:
    service.coverUrl
      ? mediaMap[service.coverUrl] ?? null
      : null,

  children: children.map(child => ({
    ...child,
    ...resolveServiceCapabilities({
      ...child,
      parent: service,
    }),
  })),
};

res.json(
successResponse(formattedService)
);
});


//////////////////////////////////////////////////////
// SEARCH SERVICES
//////////////////////////////////////////////////////

export const searchServices = catchAsync(
  async (req: Request, res: Response) => {

    const branchId =
      typeof req.query.branchId ===
      "string"
        ? req.query.branchId
        : undefined;

    const query = getParam(
      req.query.q,
      "search query"
    ).trim();

    //////////////////////////////////////////////////////
    // DISABLE CACHE ⭐ IMPORTANT
    //////////////////////////////////////////////////////

    res.setHeader("Cache-Control", "no-store");

    //////////////////////////////////////////////////////
    // 1️⃣ MATCH SERVICES
    //////////////////////////////////////////////////////

    const matchedServices =
      await prisma.serviceNode.findMany({
        where: {
          isActive: true,
          OR: [
            {
              name: {
                contains: query,
                mode: "insensitive",
              },
            },
            {
              slug: {
                contains: query,
                mode: "insensitive",
              },
            },
          ],
        },
        include: {
          parent: {
            include: {
              parent: true,
            },
          },
        },
        take: 20,
      });

    //////////////////////////////////////////////////////
    // 2️⃣ MATCH CATEGORIES
    //////////////////////////////////////////////////////

    const matchedCategories =
      await prisma.serviceNode.findMany({
        where: {
          isActive: true,
          isBookable: false,
          name: {
            contains: query,
            mode: "insensitive",
          },
        },
        include: {
          parent: {
            include: {
              parent: true,
            },
          },
        },
      });

    //////////////////////////////////////////////////////
    // 3️⃣ GET CHILD SERVICES
    //////////////////////////////////////////////////////

    const categoryIds =
      matchedCategories.map(c => c.id);

    const categoryServices =
      categoryIds.length
        ? await prisma.serviceNode.findMany({
            where: {
              parentId: {
                in: categoryIds,
              },
              isActive: true,
            },
            include: {
              parent: {
                include: {
                  parent: true,
                },
              },
            },
            orderBy: {
              sortOrder: "asc",
            },
          })
        : [];

    //////////////////////////////////////////////////////
    // MERGE RESULTS
    //////////////////////////////////////////////////////

    const servicesMap = new Map();

    [...matchedServices,
     ...categoryServices
    ].forEach(s =>
      servicesMap.set(s.id, s)
    );

    const servicesNormalized =
      (await resolveNodeMedia(
        [...servicesMap.values()]
      )).map((service) =>
        normalizePublicServiceNode(
          service,
          service.parent
        )
      );

    const categoriesNormalized =
      (await resolveNodeMedia(
        matchedCategories
      )).map((category) =>
        normalizePublicServiceNode(
          category,
          category.parent
        )
      );

    //////////////////////////////////////////////////////
    // RELATED SERVICES (SIBLINGS)
    //////////////////////////////////////////////////////

    const parentIds = [
      ...new Set(
        servicesNormalized
          .map((service) => service.parentId)
          .filter(
            (parentId): parentId is string =>
              typeof parentId ===
              "string" &&
              parentId.length > 0
          )
      ),
    ];

    const related =
      parentIds.length
        ? await prisma.serviceNode.findMany({
            where: {
              parentId: {
                in: parentIds,
              },
              isActive: true,
            },
            include: {
              parent: {
                include: {
                  parent: true,
                },
              },
            },
          })
        : [];

    const relatedNormalized =
      (await resolveNodeMedia(related)).map(
        (service) =>
          normalizePublicServiceNode(
            service,
            service.parent
          )
      );

    const [
      services,
      categories,
      relatedServices,
    ] = await Promise.all([
      withBranchAvailability(
        servicesNormalized,
        branchId
      ).then((nodes) =>
        withReviewSummary(nodes)
      ),
      withBranchAvailability(
        categoriesNormalized,
        branchId,
        {
          filterUnavailableBookable: false,
        }
      ).then((nodes) =>
        withReviewSummary(nodes)
      ),
      withBranchAvailability(
        relatedNormalized,
        branchId
      ).then((nodes) =>
        withReviewSummary(nodes)
      ),
    ]);

    //////////////////////////////////////////////////////
    // RESPONSE
    //////////////////////////////////////////////////////

    res.json(
      successResponse({
        query,
        categories,
        services,
        relatedServices,
      })
    );
  }
);
