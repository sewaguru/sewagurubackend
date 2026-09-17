import {
  NotificationDeliveryChannel,
  NotificationDeliveryStatus,
  NotificationEvent,
  Prisma,
} from "../generated/prisma";
import { config } from "../config/config";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import {
  assertEmailProviderReady,
  sendEmail,
} from "./email.service";
import {
  getBookingItemNames,
  hydrateBookingForResponse,
} from "../utils/bookingSnapshot";
import { normalizeCouponCode } from "./coupon.service";

const PLATFORM_SETTING_KEY = "default";
const SITE_NAME = "SewaGuru";
const DEFAULT_CLIENT_URL =
  "https://sewaguru.in";

const EMAIL_SETTINGS_SELECT = {
  emailNotificationsEnabled: true,
  welcomeEmailEnabled: true,
  welcomeCouponsEnabled: true,
  bookingConfirmationEmailEnabled: true,
  bookingCompletionEmailEnabled: true,
  paymentConfirmationEmailEnabled: true,
  welcomeCouponCodes: true,
  emailTemplates: true,
  updatedAt: true,
} satisfies Prisma.PlatformSettingSelect;

export const EMAIL_TEMPLATE_KEYS = [
  "welcome",
  "bookingConfirmation",
  "bookingCompletion",
  "paymentConfirmation",
] as const;

export type EmailTemplateKey =
  (typeof EMAIL_TEMPLATE_KEYS)[number];

export type EmailTemplateDefinition = {
  subject: string;
  heading: string;
  body: string;
  ctaLabel: string;
  footer: string;
};

export type EmailTemplateMap = Record<
  EmailTemplateKey,
  EmailTemplateDefinition
>;

export type EmailDeliveryLogSummary = {
  id: string;
  event: NotificationEvent;
  status: NotificationDeliveryStatus;
  recipient: string | null;
  subject: string | null;
  provider: string | null;
  errorMessage: string | null;
  bookingId: string | null;
  bookingDisplayId: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: string;
};

export type EmailManagementSettings = {
  notificationsEnabled: boolean;
  events: {
    welcomeEmailEnabled: boolean;
    welcomeCouponsEnabled: boolean;
    bookingConfirmationEmailEnabled: boolean;
    bookingCompletionEmailEnabled: boolean;
    paymentConfirmationEmailEnabled: boolean;
  };
  welcomeCouponCodes: string[];
  templates: EmailTemplateMap;
  provider: {
    enabled: boolean;
    ready: boolean;
    provider: string;
    from: string | null;
  };
  availableVariables: Record<
    EmailTemplateKey,
    string[]
  >;
  recentLogs: EmailDeliveryLogSummary[];
  updatedAt: string | null;
};

type PlatformEmailSettingsRecord =
  Prisma.PlatformSettingGetPayload<{
    select: typeof EMAIL_SETTINGS_SELECT;
  }>;

type StoredTemplates = Partial<
  Record<
    EmailTemplateKey,
    Partial<EmailTemplateDefinition>
  >
>;

type TemplateVariables = Record<
  string,
  string
>;

type BookingEmailContext = {
  bookingId: string;
  bookingDisplayId: string;
  customerName: string;
  recipient: string | null;
  customerPhone: string;
  customerEmail: string;
  serviceSummary: string;
  itemizedServices: string;
  scheduledAt: string;
  branchName: string;
  addressSummary: string;
  addressContact: string;
  paymentStatus: string;
  bookingStatus: string;
  subtotalAmount: string;
  taxAmount: string;
  discountAmount: string;
  totalAmount: string;
  invoiceSummary: string;
  pricingNote: string;
  orderLink: string;
  userId: string;
};

const DEFAULT_EMAIL_TEMPLATES: EmailTemplateMap = {
  welcome: {
    subject:
      "Welcome to {{siteName}}, {{customerName}}",
    heading: "Welcome to {{siteName}}",
    body: `Hi {{customerName}},

Thanks for signing up with {{siteName}}. We are glad to have you here.

You can now explore trusted home services, track bookings, and manage everything from one place.

{{welcomeCoupons}}`,
    ctaLabel: "Browse services",
    footer:
      "Need help? Reply to this email and our team will assist you.",
  },
  bookingConfirmation: {
    subject:
      "Your booking {{bookingId}} is confirmed",
    heading: "Your booking is confirmed",
    body: `Hi {{customerName}},

Your booking {{bookingId}} has been created successfully.

Service: {{serviceSummary}}
Scheduled for: {{scheduledAt}}
Branch: {{branchName}}
Service address: {{addressSummary}}
Address contact: {{addressContact}}
Customer phone: {{customerPhone}}
Customer email: {{customerEmail}}
Booking status: {{bookingStatus}}
Payment status: {{paymentStatus}}
Amount at booking: {{totalAmount}}

Invoice details:
{{invoiceSummary}}

{{pricingNote}}`,
    ctaLabel: "View booking",
    footer:
      "We will keep you updated as your booking moves forward.",
  },
  bookingCompletion: {
    subject:
      "Your booking {{bookingId}} is completed",
    heading: "Booking completed",
    body: `Hi {{customerName}},

Your booking {{bookingId}} for {{serviceSummary}} has been marked as completed.

Service address: {{addressSummary}}
Customer phone: {{customerPhone}}
Customer email: {{customerEmail}}
Final booking summary:
{{invoiceSummary}}

If you need any follow-up support, just reply to this email or open the booking details in your account.`,
    ctaLabel: "Open booking",
    footer:
      "Thank you for choosing {{siteName}}.",
  },
  paymentConfirmation: {
    subject:
      "Payment confirmed for booking {{bookingId}}",
    heading: "Payment received — your booking is confirmed",
    body: `Hi {{customerName}},

We have received your payment of {{totalAmount}} for booking {{bookingId}}.

Service: {{serviceSummary}}
Scheduled for: {{scheduledAt}}
Branch: {{branchName}}
Service address: {{addressSummary}}
Payment status: Paid

Invoice details:
{{invoiceSummary}}

Your booking is now active. We will keep you updated on the next steps.`,
    ctaLabel: "View booking",
    footer:
      "Thank you for choosing {{siteName}}. If you have any questions, reply to this email.",
  },
};

export const EMAIL_TEMPLATE_VARIABLES: Record<
  EmailTemplateKey,
  string[]
> = {
  welcome: [
    "{{siteName}}",
    "{{customerName}}",
    "{{welcomeCoupons}}",
  ],
  bookingConfirmation: [
    "{{customerName}}",
    "{{bookingId}}",
    "{{serviceSummary}}",
    "{{scheduledAt}}",
    "{{branchName}}",
    "{{addressSummary}}",
    "{{addressContact}}",
    "{{customerPhone}}",
    "{{customerEmail}}",
    "{{bookingStatus}}",
    "{{paymentStatus}}",
    "{{subtotalAmount}}",
    "{{taxAmount}}",
    "{{discountAmount}}",
    "{{totalAmount}}",
    "{{invoiceSummary}}",
    "{{itemizedServices}}",
    "{{pricingNote}}",
  ],
  bookingCompletion: [
    "{{siteName}}",
    "{{customerName}}",
    "{{bookingId}}",
    "{{serviceSummary}}",
    "{{addressSummary}}",
    "{{customerPhone}}",
    "{{customerEmail}}",
    "{{invoiceSummary}}",
  ],
  paymentConfirmation: [
    "{{siteName}}",
    "{{customerName}}",
    "{{bookingId}}",
    "{{serviceSummary}}",
    "{{scheduledAt}}",
    "{{branchName}}",
    "{{addressSummary}}",
    "{{totalAmount}}",
    "{{invoiceSummary}}",
  ],
};

const getClientUrl = () =>
  (
    config.CLIENT_URL ||
    DEFAULT_CLIENT_URL
  ).replace(/\/+$/, "");

const isRecord = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const toNonEmptyString = (
  value: unknown,
  fallback = ""
) => {
  if (
    typeof value === "string" &&
    value.trim().length > 0
  ) {
    return value.trim();
  }

  return fallback;
};

const getProviderStatus = () => {
  let ready = false;

  try {
    assertEmailProviderReady();
    ready = true;
  } catch {
    ready = false;
  }

  return {
    enabled: config.EMAIL_ENABLED,
    ready,
    provider:
      config.EMAIL_PROVIDER || "LOG",
    from: config.EMAIL_FROM || null,
  };
};

const cloneDefaultTemplates =
  (): EmailTemplateMap =>
    JSON.parse(
      JSON.stringify(
        DEFAULT_EMAIL_TEMPLATES
      )
    ) as EmailTemplateMap;

const readStoredTemplates = (
  value: Prisma.JsonValue | null
): StoredTemplates => {
  if (!isRecord(value)) {
    return {};
  }

  const result: StoredTemplates = {};

  for (const key of EMAIL_TEMPLATE_KEYS) {
    const rawTemplate = value[key];

    if (!isRecord(rawTemplate)) {
      continue;
    }

    result[key] = {
      subject: toNonEmptyString(
        rawTemplate.subject
      ),
      heading: toNonEmptyString(
        rawTemplate.heading
      ),
      body: toNonEmptyString(
        rawTemplate.body
      ),
      ctaLabel: toNonEmptyString(
        rawTemplate.ctaLabel
      ),
      footer: toNonEmptyString(
        rawTemplate.footer
      ),
    };
  }

  return result;
};

const mergeEmailTemplates = (
  storedTemplates?: StoredTemplates
) => {
  const templates =
    cloneDefaultTemplates();

  for (const key of EMAIL_TEMPLATE_KEYS) {
    const current =
      storedTemplates?.[key];

    if (!current) {
      continue;
    }

    templates[key] = {
      ...templates[key],
      ...current,
    };
  }

  return templates;
};

const normalizeTemplateInput = (
  value: unknown
) => {
  if (!isRecord(value)) {
    throw new AppError(
      "templates must be an object",
      400
    );
  }

  const normalized =
    cloneDefaultTemplates();

  for (const key of EMAIL_TEMPLATE_KEYS) {
    const template = value[key];

    if (!isRecord(template)) {
      throw new AppError(
        `Template '${key}' is required`,
        400
      );
    }

    const subject = toNonEmptyString(
      template.subject
    );
    const heading = toNonEmptyString(
      template.heading
    );
    const body = toNonEmptyString(
      template.body
    );
    const ctaLabel = toNonEmptyString(
      template.ctaLabel
    );
    const footer = toNonEmptyString(
      template.footer
    );

    if (!subject || !heading || !body) {
      throw new AppError(
        `Template '${key}' must include subject, heading, and body`,
        400
      );
    }

    normalized[key] = {
      subject,
      heading,
      body,
      ctaLabel,
      footer,
    };
  }

  return normalized;
};

const normalizeCouponCodes = async (
  value: unknown
) => {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(
      "welcomeCouponCodes must be an array of coupon codes",
      400
    );
  }

  const normalized = Array.from(
    new Set(
      value
        .map((item) =>
          normalizeCouponCode(
            String(item ?? "")
          )
        )
        .filter((code) => code.length > 0)
    )
  );

  if (!normalized.length) {
    return [];
  }

  const existingCoupons =
    await prisma.coupon.findMany({
      where: {
        code: {
          in: normalized,
        },
      },
      select: {
        code: true,
      },
    });

  const existingCodes = new Set(
    existingCoupons.map((coupon) =>
      coupon.code.toUpperCase()
    )
  );

  const missingCodes = normalized.filter(
    (code) => !existingCodes.has(code)
  );

  if (missingCodes.length > 0) {
    throw new AppError(
      `Unknown coupon code(s): ${missingCodes.join(
        ", "
      )}`,
      400,
      "COUPON_NOT_FOUND"
    );
  }

  return normalized;
};

const formatCurrency = (
  value: number | null | undefined
) => {
  const amount =
    typeof value === "number" &&
    Number.isFinite(value)
      ? value
      : 0;

  return new Intl.NumberFormat(
    "en-IN",
    {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }
  ).format(amount);
};

const formatDateTime = (
  value: Date | string | null | undefined
) => {
  if (!value) {
    return "To be scheduled";
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(date.getTime())
  ) {
    return "To be scheduled";
  }

  return new Intl.DateTimeFormat(
    "en-IN",
    {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }
  ).format(date);
};

const escapeHtml = (
  value: string
) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const textToHtml = (
  value: string
) =>
  value
    .split(/\n{2,}/)
    .map((paragraph) =>
      `<p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#111827;">${escapeHtml(
        paragraph
      ).replace(/\n/g, "<br />")}</p>`
    )
    .join("");

const renderTemplateString = (
  template: string,
  variables: TemplateVariables
) =>
  template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_, key: string) =>
      variables[key] ?? ""
  );

const buildEmailShell = ({
  heading,
  body,
  ctaLabel,
  ctaUrl,
  footer,
}: {
  heading: string;
  body: string;
  ctaLabel?: string | undefined;
  ctaUrl?: string | undefined;
  footer?: string | undefined;
}) => {
  const footerText =
    footer && footer.trim().length > 0
      ? footer
      : "Need help? Reply to this email and our team will assist you.";

  const html = `
    <div style="background:#f6f7fb;padding:24px 0;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e8e9ef;border-radius:18px;overflow:hidden;">
        <div style="padding:20px 24px;border-bottom:1px solid #f0f1f5;">
          <div style="font-family:Arial,sans-serif;font-size:18px;font-weight:700;color:#111827;">${SITE_NAME}</div>
          <div style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin-top:4px;">Email update from ${SITE_NAME}</div>
        </div>

        <div style="padding:24px;">
          <h1 style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(
            heading
          )}</h1>
          ${textToHtml(body)}
          ${
            ctaLabel && ctaUrl
              ? `<div style="margin:22px 0 0 0;">
                  <a href="${escapeHtml(
                    ctaUrl
                  )}" style="display:inline-block;padding:12px 18px;border-radius:12px;background:#111827;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700;">
                    ${escapeHtml(
                      ctaLabel
                    )}
                  </a>
                </div>`
              : ""
          }
        </div>

        <div style="padding:16px 24px;border-top:1px solid #f0f1f5;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#6b7280;">${escapeHtml(
            footerText
          )}</p>
        </div>
      </div>
    </div>
  `;

  const text = [
    heading,
    "",
    body,
    ctaLabel && ctaUrl
      ? `${ctaLabel}: ${ctaUrl}`
      : "",
    "",
    footerText,
  ]
    .filter(Boolean)
    .join("\n");

  return { html, text };
};

const formatCouponDiscount = (
  coupon: {
    discountType:
      | "PERCENT"
      | "FLAT";
    value: number;
    maxDiscountAmount: number | null;
  }
) => {
  if (
    coupon.discountType ===
    "PERCENT"
  ) {
    const cappedText =
      typeof coupon.maxDiscountAmount ===
        "number" &&
      coupon.maxDiscountAmount > 0
        ? ` up to ${formatCurrency(
            coupon.maxDiscountAmount
          )}`
        : "";

    return `${coupon.value}% off${cappedText}`;
  }

  return `${formatCurrency(
    coupon.value
  )} off`;
};

const getWelcomeCoupons = async (
  welcomeCouponCodes: string[]
) => {
  const now = new Date();
  const where: Prisma.CouponWhereInput = {
    isPublic: true,
    isActive: true,
    OR: [
      {
        startsAt: null,
      },
      {
        startsAt: {
          lte: now,
        },
      },
    ],
    AND: [
      {
        OR: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              gte: now,
            },
          },
        ],
      },
    ],
    ...(welcomeCouponCodes.length > 0
      ? {
          code: {
            in: welcomeCouponCodes,
          },
        }
      : {
          firstBookingOnly: true,
        }),
  };

  const coupons =
    await prisma.coupon.findMany({
      where,
      orderBy: [
        {
          firstBookingOnly: "desc",
        },
        {
          updatedAt: "desc",
        },
      ],
      take: welcomeCouponCodes.length > 0
        ? welcomeCouponCodes.length
        : 4,
      select: {
        code: true,
        title: true,
        description: true,
        discountType: true,
        value: true,
        maxDiscountAmount: true,
      },
    });

  if (!coupons.length) {
    return "";
  }

  return coupons
    .map((coupon) => {
      const description =
        coupon.title?.trim() ||
        coupon.description?.trim() ||
        formatCouponDiscount(coupon);

      return `- ${coupon.code}: ${description}`;
    })
    .join("\n");
};

const buildRecipientName = ({
  fullName,
  email,
}: {
  fullName?: string | null | undefined;
  email?: string | null | undefined;
}) => {
  const cleanName =
    fullName?.trim();

  if (cleanName) {
    return cleanName;
  }

  const local =
    email?.split("@")[0]?.trim() ??
    "";

  if (!local) {
    return "Customer";
  }

  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) =>
      char.toUpperCase()
    );
};

const getUserRecipient = async (
  userId: string
) => {
  const user =
    await prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        authMethods: {
          select: {
            identifier: true,
            identifierType: true,
            isVerified: true,
            isPrimary: true,
            createdAt: true,
          },
          orderBy: [
            {
              isPrimary: "desc",
            },
            {
              isVerified: "desc",
            },
            {
              createdAt: "asc",
            },
          ],
        },
      },
    });

  if (!user) {
    return null;
  }

  const emailFromProfile =
    user.profile?.email?.trim() ||
    null;
  const emailFromAuth =
    user.authMethods.find(
      (method) =>
        method.identifierType ===
        "EMAIL"
    )?.identifier?.trim() || null;

  const email =
    emailFromProfile ||
    emailFromAuth;

  return {
    userId: user.id,
    email,
    customerName:
      buildRecipientName({
        fullName:
          user.profile?.fullName,
        email:
          emailFromProfile ||
          emailFromAuth,
      }),
  };
};

const buildAddressSummary = (
  booking: ReturnType<
    typeof hydrateBookingForResponse
  >
) => {
  const address = booking.address as
    | {
        addressLine1?: string | null;
        addressLine2?: string | null;
        locality?: string | null;
        city?: {
          name?: string | null;
          state?: string | null;
        } | null;
      }
    | null
    | undefined;

  const parts = [
    address?.addressLine1,
    address?.addressLine2,
    address?.locality,
    address?.city?.name,
    address?.city?.state,
  ].filter(
    (part): part is string =>
      typeof part === "string" &&
      part.trim().length > 0
  );

  return parts.length
    ? parts.join(", ")
    : "Address available in booking details";
};

const buildAddressContactSummary = (
  booking: ReturnType<
    typeof hydrateBookingForResponse
  >
) => {
  const address = booking.address as
    | {
        contactName?: string | null;
        contactPhone?: string | null;
      }
    | null
    | undefined;

  const parts = [
    address?.contactName,
    address?.contactPhone,
  ].filter(
    (part): part is string =>
      typeof part === "string" &&
      part.trim().length > 0
  );

  return parts.length
    ? parts.join(" | ")
    : "Use the booking contact details on the order page";
};

const buildInvoiceSummary = ({
  booking,
  hydratedBooking,
}: {
  booking: Prisma.BookingGetPayload<{
    include: {
      items: {
        include: {
          serviceNode: {
            select: {
              id: true;
              name: true;
              slug: true;
            };
          };
        };
      };
    };
  }>;
  hydratedBooking: ReturnType<
    typeof hydrateBookingForResponse
  >;
}) => {
  const items = Array.isArray(
    hydratedBooking.items
  )
    ? hydratedBooking.items
    : [];
  const hasStartingAtPricing =
    items.some((item) => {
      const snapshot =
        item as {
          serviceSnapshot?: {
            consultationOnly?: boolean | null;
            priceType?: string | null;
            pricingType?: string | null;
          } | null;
          serviceNode?: {
            consultationOnly?: boolean | null;
            priceType?: string | null;
            pricingType?: string | null;
          } | null;
        };

      if (
        snapshot.serviceSnapshot
          ?.consultationOnly ===
          true ||
        snapshot.serviceNode
          ?.consultationOnly ===
          true
      ) {
        return false;
      }

      return (
        snapshot.serviceSnapshot
          ?.priceType ===
          "STARTING_AT" ||
        snapshot.serviceSnapshot
          ?.priceType ===
          "STARTING_FROM" ||
        snapshot.serviceSnapshot
          ?.pricingType ===
          "VARIABLE" ||
        snapshot.serviceNode
          ?.priceType ===
          "STARTING_AT" ||
        snapshot.serviceNode
          ?.priceType ===
          "STARTING_FROM" ||
        snapshot.serviceNode
          ?.pricingType ===
          "VARIABLE"
      );
    });

  const itemLines = items.map(
    (item) => {
      const serviceName =
        ((item as {
          serviceSnapshot?: {
            name?: string | null;
            consultationOnly?: boolean | null;
          } | null;
          serviceNode?: {
            name?: string | null;
          } | null;
        }).serviceSnapshot?.name ||
          (item as {
            serviceNode?: {
              name?: string | null;
            } | null;
          }).serviceNode?.name ||
          "Service") as string;

      const quantity = Number(
        (item as { quantity?: number })
          .quantity ?? 1
      );
      const price = Number(
        (item as { price?: number })
          .price ?? 0
      );
      const consultationOnly =
        (item as {
          serviceSnapshot?: {
            consultationOnly?: boolean | null;
          } | null;
        }).serviceSnapshot
          ?.consultationOnly === true;

      const lineTotal =
        price * quantity;

      return `- ${serviceName} x ${quantity}: ${
        lineTotal > 0
          ? formatCurrency(
              lineTotal
            )
          : consultationOnly
            ? "Visit booking"
            : "Amount pending"
      }`;
    }
  );

  const summaryLines = [
    ...itemLines,
    `${hasStartingAtPricing ? "Base amount" : "Subtotal"}: ${formatCurrency(
      booking.subtotal
    )}`,
    `Tax: ${formatCurrency(
      booking.taxAmount
    )}`,
    `Discount: -${formatCurrency(
      booking.discountAmount
    )}`,
    `${hasStartingAtPricing ? "Payable at booking" : "Total"}: ${formatCurrency(
      booking.totalAmount
    )}`,
  ];

  return summaryLines.join("\n");
};

const getBookingEmailContext = async (
  bookingId: string
): Promise<BookingEmailContext | null> => {
  const booking =
    await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
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
                isVerified: true,
                isPrimary: true,
                createdAt: true,
              },
              orderBy: [
                {
                  isPrimary: "desc",
                },
                {
                  isVerified: "desc",
                },
                {
                  createdAt: "asc",
                },
              ],
            },
          },
        },
      },
    });

  if (!booking) {
    return null;
  }

  const hydratedBooking =
    hydrateBookingForResponse(booking);
  const profileEmail =
    booking.user.profile?.email?.trim() ||
    null;
  const authEmail =
    booking.user.authMethods.find(
      (method) =>
        method.identifierType ===
        "EMAIL"
    )?.identifier?.trim() || null;
  const authPhone =
    booking.user.authMethods.find(
      (method) =>
        method.identifierType ===
          "PHONE" &&
        method.isPrimary
    )?.identifier?.trim() ||
    booking.user.authMethods.find(
      (method) =>
        method.identifierType ===
          "PHONE" &&
        method.isVerified
    )?.identifier?.trim() ||
    booking.user.authMethods.find(
      (method) =>
        method.identifierType ===
        "PHONE"
    )?.identifier?.trim() ||
    null;
  const recipient =
    profileEmail || authEmail;
  const itemizedServices =
    buildInvoiceSummary({
      booking,
      hydratedBooking,
    });
  const hasStartingAtPricing =
    Array.isArray(
      hydratedBooking.items
    ) &&
    hydratedBooking.items.some(
      (item) => {
        const snapshot =
          item as {
            serviceSnapshot?: {
              consultationOnly?: boolean | null;
              priceType?: string | null;
              pricingType?: string | null;
            } | null;
            serviceNode?: {
              consultationOnly?: boolean | null;
              priceType?: string | null;
              pricingType?: string | null;
            } | null;
          };

        if (
          snapshot.serviceSnapshot
            ?.consultationOnly ===
            true ||
          snapshot.serviceNode
            ?.consultationOnly ===
            true
        ) {
          return false;
        }

        return (
          snapshot.serviceSnapshot
            ?.priceType ===
            "STARTING_AT" ||
          snapshot.serviceSnapshot
            ?.priceType ===
            "STARTING_FROM" ||
          snapshot.serviceSnapshot
            ?.pricingType ===
            "VARIABLE" ||
          snapshot.serviceNode
            ?.priceType ===
            "STARTING_AT" ||
          snapshot.serviceNode
            ?.priceType ===
            "STARTING_FROM" ||
          snapshot.serviceNode
            ?.pricingType ===
            "VARIABLE"
        );
      }
    );

  const pricingNote =
    booking.paymentStatus ===
      "NOT_REQUIRED" ||
    (typeof booking.totalAmount ===
      "number" &&
      booking.totalAmount <= 0)
      ? "Only the visit request has been placed right now. Final pricing will be shared after inspection if applicable."
      : hasStartingAtPricing
        ? "This booking includes starting-from pricing. The amount shown now covers the base booking amount. Additional charges may be collected later depending on final requirements, measurements, materials, add-ons, or service scope."
      : "You can review the booking and payment details anytime from your order page.";

  return {
    bookingId: booking.id,
    bookingDisplayId:
      booking.displayId ??
      booking.id,
    customerName:
      buildRecipientName({
        fullName:
          booking.user.profile?.fullName,
        email: recipient,
      }),
    recipient,
    customerPhone:
      authPhone ||
      "Not provided",
    customerEmail:
      recipient ||
      "Not provided",
    serviceSummary:
      getBookingItemNames(
        hydratedBooking.items
      ),
    itemizedServices,
    scheduledAt:
      formatDateTime(
        booking.scheduledAt
      ),
    branchName:
      hydratedBooking.branch?.name ??
      "SewaGuru",
    addressSummary:
      buildAddressSummary(
        hydratedBooking
      ),
    addressContact:
      buildAddressContactSummary(
        hydratedBooking
      ),
    paymentStatus:
      booking.paymentStatus
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (char) =>
          char.toUpperCase()
        ),
    bookingStatus:
      booking.status
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (char) =>
          char.toUpperCase()
        ),
    subtotalAmount:
      formatCurrency(
        booking.subtotal
      ),
    taxAmount:
      formatCurrency(
        booking.taxAmount
      ),
    discountAmount:
      formatCurrency(
        booking.discountAmount
      ),
    totalAmount:
      formatCurrency(
        booking.totalAmount
      ),
    invoiceSummary:
      itemizedServices,
    pricingNote,
    orderLink: `${getClientUrl()}/orders/${
      booking.id
    }`,
    userId: booking.userId,
  };
};

const formatRecentLogs = (
  logs: Array<
    Prisma.NotificationDeliveryLogGetPayload<{
      include: {
        user: {
          include: {
            profile: true;
          };
        };
        booking: {
          select: {
            id: true;
            displayId: true;
          };
        };
      };
    }>
  >
) =>
  logs.map((log) => ({
    id: log.id,
    event: log.event,
    status: log.status,
    recipient:
      log.recipient ?? null,
    subject: log.subject ?? null,
    provider:
      log.provider ?? null,
    errorMessage:
      log.errorMessage ?? null,
    bookingId:
      log.bookingId ?? null,
    bookingDisplayId:
      log.booking?.displayId ??
      log.bookingId ??
      null,
    userId: log.userId ?? null,
    userName:
      log.user?.profile?.fullName ??
      null,
    createdAt:
      log.createdAt.toISOString(),
  }));

const getRecentEmailLogs = async (
  limit = 12
) => {
  const logs =
    await prisma.notificationDeliveryLog.findMany(
      {
        where: {
          channel:
            NotificationDeliveryChannel.EMAIL,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limit,
        include: {
          user: {
            include: {
              profile: true,
            },
          },
          booking: {
            select: {
              id: true,
              displayId: true,
            },
          },
        },
      }
    );

  return formatRecentLogs(logs);
};

const toEmailManagementSettings = async (
  record?: PlatformEmailSettingsRecord | null
): Promise<EmailManagementSettings> => {
  const recentLogs =
    await getRecentEmailLogs();

  return {
    notificationsEnabled:
      record?.emailNotificationsEnabled ??
      true,
    events: {
      welcomeEmailEnabled:
        record?.welcomeEmailEnabled ??
        true,
      welcomeCouponsEnabled:
        record?.welcomeCouponsEnabled ??
        true,
      bookingConfirmationEmailEnabled:
        record?.bookingConfirmationEmailEnabled ??
        true,
      bookingCompletionEmailEnabled:
        record?.bookingCompletionEmailEnabled ??
        true,
      paymentConfirmationEmailEnabled:
        record?.paymentConfirmationEmailEnabled ??
        true,
    },
    welcomeCouponCodes:
      record?.welcomeCouponCodes ?? [],
    templates: mergeEmailTemplates(
      readStoredTemplates(
        record?.emailTemplates ?? null
      )
    ),
    provider: getProviderStatus(),
    availableVariables:
      EMAIL_TEMPLATE_VARIABLES,
    recentLogs,
    updatedAt:
      record?.updatedAt?.toISOString() ??
      null,
  };
};

export const getAdminEmailManagementSettings =
  async () => {
    const record =
      await prisma.platformSetting.findUnique(
        {
          where: {
            key: PLATFORM_SETTING_KEY,
          },
          select:
            EMAIL_SETTINGS_SELECT,
        }
      );

    return toEmailManagementSettings(
      record
    );
  };

export const updateAdminEmailManagementSettings =
  async (input: {
    notificationsEnabled: boolean;
    welcomeEmailEnabled: boolean;
    welcomeCouponsEnabled: boolean;
    bookingConfirmationEmailEnabled: boolean;
    bookingCompletionEmailEnabled: boolean;
    paymentConfirmationEmailEnabled: boolean;
    welcomeCouponCodes: unknown;
    templates: unknown;
  }) => {
    const welcomeCouponCodes =
      await normalizeCouponCodes(
        input.welcomeCouponCodes
      );
    const templates =
      normalizeTemplateInput(
        input.templates
      );

    const record =
      await prisma.platformSetting.upsert({
        where: {
          key: PLATFORM_SETTING_KEY,
        },
        create: {
          key: PLATFORM_SETTING_KEY,
          emailNotificationsEnabled:
            input.notificationsEnabled,
          welcomeEmailEnabled:
            input.welcomeEmailEnabled,
          welcomeCouponsEnabled:
            input.welcomeCouponsEnabled,
          bookingConfirmationEmailEnabled:
            input.bookingConfirmationEmailEnabled,
          bookingCompletionEmailEnabled:
            input.bookingCompletionEmailEnabled,
          paymentConfirmationEmailEnabled:
            input.paymentConfirmationEmailEnabled,
          welcomeCouponCodes,
          emailTemplates:
            templates as Prisma.InputJsonValue,
        },
        update: {
          emailNotificationsEnabled:
            input.notificationsEnabled,
          welcomeEmailEnabled:
            input.welcomeEmailEnabled,
          welcomeCouponsEnabled:
            input.welcomeCouponsEnabled,
          bookingConfirmationEmailEnabled:
            input.bookingConfirmationEmailEnabled,
          bookingCompletionEmailEnabled:
            input.bookingCompletionEmailEnabled,
          paymentConfirmationEmailEnabled:
            input.paymentConfirmationEmailEnabled,
          welcomeCouponCodes,
          emailTemplates:
            templates as Prisma.InputJsonValue,
        },
        select:
          EMAIL_SETTINGS_SELECT,
      });

    return toEmailManagementSettings(
      record
    );
  };

const getResolvedEmailSettings = async () => {
  const record =
    await prisma.platformSetting.findUnique({
      where: {
        key: PLATFORM_SETTING_KEY,
      },
      select:
        EMAIL_SETTINGS_SELECT,
    });

  return {
    notificationsEnabled:
      record?.emailNotificationsEnabled ??
      true,
    welcomeEmailEnabled:
      record?.welcomeEmailEnabled ?? true,
    welcomeCouponsEnabled:
      record?.welcomeCouponsEnabled ??
      true,
    bookingConfirmationEmailEnabled:
      record?.bookingConfirmationEmailEnabled ??
      true,
    bookingCompletionEmailEnabled:
      record?.bookingCompletionEmailEnabled ??
      true,
    paymentConfirmationEmailEnabled:
      record?.paymentConfirmationEmailEnabled ??
      true,
    welcomeCouponCodes:
      record?.welcomeCouponCodes ?? [],
    templates: mergeEmailTemplates(
      readStoredTemplates(
        record?.emailTemplates ?? null
      )
    ),
  };
};

const logDelivery = async (payload: {
  event: NotificationEvent;
  status: NotificationDeliveryStatus;
  recipient?: string | null | undefined;
  subject?: string | null | undefined;
  provider?: string | null | undefined;
  errorMessage?: string | null | undefined;
  userId?: string | null | undefined;
  bookingId?: string | null | undefined;
  payload?: Record<
    string,
    unknown
  > | undefined;
}) =>
  prisma.notificationDeliveryLog.create({
    data: {
      channel:
        NotificationDeliveryChannel.EMAIL,
      event: payload.event,
      status: payload.status,
      recipient:
        payload.recipient ?? null,
      subject:
        payload.subject ?? null,
      provider:
        payload.provider ?? null,
      errorMessage:
        payload.errorMessage ?? null,
      userId:
        payload.userId ?? null,
      bookingId:
        payload.bookingId ?? null,
      payload:
        (payload.payload ??
          null) as Prisma.InputJsonValue,
    },
  });

const sendManagedEmail = async ({
  event,
  templateKey,
  recipient,
  userId,
  bookingId,
  variables,
  ctaUrl,
}: {
  event: NotificationEvent;
  templateKey: EmailTemplateKey;
  recipient: string | null;
  userId?: string | null;
  bookingId?: string | null;
  variables: TemplateVariables;
  ctaUrl?: string;
}) => {
  const settings =
    await getResolvedEmailSettings();

  const eventEnabled =
    settings.notificationsEnabled &&
    (
      event === NotificationEvent.USER_SIGNUP_WELCOME
        ? settings.welcomeEmailEnabled
        : event === NotificationEvent.BOOKING_CONFIRMATION
        ? settings.bookingConfirmationEmailEnabled
        : event === NotificationEvent.PAYMENT_CONFIRMATION
        ? settings.paymentConfirmationEmailEnabled
        : settings.bookingCompletionEmailEnabled
    );

  if (!eventEnabled) {
    await logDelivery({
      event,
      status:
        NotificationDeliveryStatus.SKIPPED,
      recipient,
      userId,
      bookingId,
      provider:
        config.EMAIL_PROVIDER || null,
      errorMessage:
        "Email event disabled in settings",
      payload: {
        templateKey,
      },
    });
    return;
  }

  if (!recipient) {
    await logDelivery({
      event,
      status:
        NotificationDeliveryStatus.SKIPPED,
      recipient: null,
      userId,
      bookingId,
      provider:
        config.EMAIL_PROVIDER || null,
      errorMessage:
        "Recipient email is missing",
      payload: {
        templateKey,
      },
    });
    return;
  }

  const providerStatus =
    getProviderStatus();

  const template =
    settings.templates[templateKey];
  const renderedSubject =
    renderTemplateString(
      template.subject,
      variables
    );
  const renderedHeading =
    renderTemplateString(
      template.heading,
      variables
    );
  const renderedBody =
    renderTemplateString(
      template.body,
      variables
    ).trim();
  const renderedFooter =
    renderTemplateString(
      template.footer,
      variables
    );
  const renderedCtaLabel =
    renderTemplateString(
      template.ctaLabel,
      variables
    );

  if (!providerStatus.ready) {
    await logDelivery({
      event,
      status:
        NotificationDeliveryStatus.FAILED,
      recipient,
      subject: renderedSubject,
      userId,
      bookingId,
      provider:
        providerStatus.provider,
      errorMessage:
        "Email provider is not ready",
      payload: {
        templateKey,
      },
    });
    return;
  }

  const { html, text } =
    buildEmailShell({
      heading: renderedHeading,
      body: renderedBody,
      ctaLabel:
        renderedCtaLabel || undefined,
      ctaUrl,
      footer: renderedFooter,
    });

  try {
    await sendEmail(
      recipient,
      renderedSubject,
      html,
      text
    );

    await logDelivery({
      event,
      status:
        NotificationDeliveryStatus.SENT,
      recipient,
      subject: renderedSubject,
      userId,
      bookingId,
      provider:
        providerStatus.provider,
      payload: {
        templateKey,
      },
    });
  } catch (error) {
    await logDelivery({
      event,
      status:
        NotificationDeliveryStatus.FAILED,
      recipient,
      subject: renderedSubject,
      userId,
      bookingId,
      provider:
        providerStatus.provider,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to send email",
      payload: {
        templateKey,
      },
    });
  }
};

export const sendSignupWelcomeEmail =
  async (userId: string) => {
    const recipient =
      await getUserRecipient(userId);

    if (!recipient) {
      return;
    }

    const settings =
      await getResolvedEmailSettings();
    const couponsText =
      settings.welcomeCouponsEnabled
        ? await getWelcomeCoupons(
            settings.welcomeCouponCodes
          )
        : "";
    const welcomeCoupons =
      couponsText.trim().length > 0
        ? `Here are your welcome coupon codes:\n${couponsText}`
        : "Welcome coupons will appear here when active offers are available.";

    await sendManagedEmail({
      event:
        NotificationEvent.USER_SIGNUP_WELCOME,
      templateKey: "welcome",
      recipient: recipient.email,
      userId,
      variables: {
        siteName: SITE_NAME,
        customerName:
          recipient.customerName,
        welcomeCoupons:
          settings.welcomeCouponsEnabled
            ? welcomeCoupons
            : "",
      },
      ctaUrl: `${getClientUrl()}/services`,
    });
  };

export const sendBookingConfirmationEmail =
  async (bookingId: string) => {
    const context =
      await getBookingEmailContext(
        bookingId
      );

    if (!context) {
      return;
    }

    await sendManagedEmail({
      event:
        NotificationEvent.BOOKING_CONFIRMATION,
      templateKey:
        "bookingConfirmation",
      recipient: context.recipient,
      userId: context.userId,
      bookingId:
        context.bookingId,
      variables: {
        customerName:
          context.customerName,
        bookingId:
          context.bookingDisplayId,
        serviceSummary:
          context.serviceSummary,
        itemizedServices:
          context.itemizedServices,
        scheduledAt:
          context.scheduledAt,
        branchName:
          context.branchName,
        addressSummary:
          context.addressSummary,
        addressContact:
          context.addressContact,
        customerPhone:
          context.customerPhone,
        customerEmail:
          context.customerEmail,
        bookingStatus:
          context.bookingStatus,
        paymentStatus:
          context.paymentStatus,
        subtotalAmount:
          context.subtotalAmount,
        taxAmount:
          context.taxAmount,
        discountAmount:
          context.discountAmount,
        totalAmount:
          context.totalAmount,
        invoiceSummary:
          context.invoiceSummary,
        pricingNote:
          context.pricingNote,
      },
      ctaUrl: context.orderLink,
    });
  };

const ADMIN_ALERT_EMAIL = "sewaguruofficial@gmail.com";

export const sendBookingAdminAlertEmail =
  async (bookingId: string) => {
    const context =
      await getBookingEmailContext(bookingId);

    if (!context) {
      return;
    }

    const providerStatus = getProviderStatus();
    if (!providerStatus.ready) {
      return;
    }

    const subject = `New booking ${context.bookingDisplayId} — ${context.serviceSummary}`;
    const body = `New booking received.

Booking ID: ${context.bookingDisplayId}
Customer: ${context.customerName}
Phone: ${context.customerPhone}
Email: ${context.customerEmail}
Service: ${context.serviceSummary}
Scheduled: ${context.scheduledAt}
Branch: ${context.branchName}
Address: ${context.addressSummary}
Address contact: ${context.addressContact}
Payment status: ${context.paymentStatus}
Booking status: ${context.bookingStatus}

Invoice:
${context.invoiceSummary}

View booking: ${context.orderLink}`;

    const { html, text } = buildEmailShell({
      heading: `New booking: ${context.bookingDisplayId}`,
      body,
      ctaLabel: "View booking",
      ctaUrl: context.orderLink,
    });

    try {
      await sendEmail(ADMIN_ALERT_EMAIL, subject, html, text);
    } catch (error) {
      console.error("[EMAIL] Failed to send admin alert email", {
        bookingId,
        error,
      });
    }
  };

export const sendBookingCompletionEmail =
  async (bookingId: string) => {
    const context =
      await getBookingEmailContext(
        bookingId
      );

    if (!context) {
      return;
    }

    await sendManagedEmail({
      event:
        NotificationEvent.BOOKING_COMPLETION,
      templateKey:
        "bookingCompletion",
      recipient: context.recipient,
      userId: context.userId,
      bookingId:
        context.bookingId,
      variables: {
        siteName: SITE_NAME,
        customerName:
          context.customerName,
        bookingId:
          context.bookingDisplayId,
        serviceSummary:
          context.serviceSummary,
        addressSummary:
          context.addressSummary,
        customerPhone:
          context.customerPhone,
        customerEmail:
          context.customerEmail,
        invoiceSummary:
          context.invoiceSummary,
      },
      ctaUrl: context.orderLink,
    });
  };

export const sendPaymentConfirmationEmail =
  async (bookingId: string) => {
    const context =
      await getBookingEmailContext(
        bookingId
      );

    if (!context) {
      return;
    }

    await sendManagedEmail({
      event:
        NotificationEvent.PAYMENT_CONFIRMATION,
      templateKey:
        "paymentConfirmation",
      recipient: context.recipient,
      userId: context.userId,
      bookingId:
        context.bookingId,
      variables: {
        siteName: SITE_NAME,
        customerName:
          context.customerName,
        bookingId:
          context.bookingDisplayId,
        serviceSummary:
          context.serviceSummary,
        scheduledAt:
          context.scheduledAt,
        branchName:
          context.branchName,
        addressSummary:
          context.addressSummary,
        totalAmount:
          context.totalAmount,
        invoiceSummary:
          context.invoiceSummary,
      },
      ctaUrl: context.orderLink,
    });
  };
