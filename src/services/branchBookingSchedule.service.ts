import { Branch, BranchBookingClosure, BranchBookingSettings, Weekday } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";

export const DEFAULT_BRANCH_BOOKING_SETTINGS = {
  timezone: "Asia/Kolkata",
  openingTime: "07:00",
  closingTime: "19:00",
  slotIntervalMinutes: 60,
  minLeadMinutes: 60,
  maxAdvanceDays: 30,
  allowBookings: true,
  weeklyOffDays: [] as Weekday[],
  closedMessage: null as string | null,
};

const TIME_24H_PATTERN =
  /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const WEEKDAY_BY_SHORT: Record<string, Weekday> = {
  Sun: "SUNDAY",
  Mon: "MONDAY",
  Tue: "TUESDAY",
  Wed: "WEDNESDAY",
  Thu: "THURSDAY",
  Fri: "FRIDAY",
  Sat: "SATURDAY",
};

const WEEKDAY_LABELS: Record<Weekday, string> = {
  SUNDAY: "Sunday",
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
};

const dateTimeFormatters = new Map<
  string,
  Intl.DateTimeFormat
>();

const getDateTimeFormatter = (
  timezone: string
) => {
  const key = timezone.trim() || DEFAULT_BRANCH_BOOKING_SETTINGS.timezone;

  if (!dateTimeFormatters.has(key)) {
    dateTimeFormatters.set(
      key,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: key,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
    );
  }

  return dateTimeFormatters.get(key)!;
};

const getZonedParts = (
  date: Date,
  timezone: string
): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: Weekday;
} => {
  const parts = getDateTimeFormatter(
    timezone
  ).formatToParts(date);

  const lookup = Object.fromEntries(
    parts
      .filter(
        (part) =>
          part.type !== "literal"
      )
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;

  const weekdayToken =
    lookup.weekday;
  const weekday: Weekday =
    weekdayToken &&
    weekdayToken in WEEKDAY_BY_SHORT
      ? WEEKDAY_BY_SHORT[
          weekdayToken as keyof typeof WEEKDAY_BY_SHORT
        ]!
      : "SUNDAY";

  return {
    year: lookup.year ?? "1970",
    month: lookup.month ?? "01",
    day: lookup.day ?? "01",
    hour: lookup.hour ?? "00",
    minute: lookup.minute ?? "00",
    second: lookup.second ?? "00",
    weekday,
  };
};

const getDateKeyInTimezone = (
  date: Date,
  timezone: string
) => {
  const parts = getZonedParts(
    date,
    timezone
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
};

const getMinutesInTimezone = (
  date: Date,
  timezone: string
) => {
  const parts = getZonedParts(
    date,
    timezone
  );

  return (
    Number(parts.hour) * 60 +
    Number(parts.minute)
  );
};

const getWeekdayInTimezone = (
  date: Date,
  timezone: string
) =>
  getZonedParts(date, timezone)
    .weekday;

const normalizeTimeValue = (
  value: unknown,
  label: string
) => {
  if (
    typeof value !== "string" ||
    !TIME_24H_PATTERN.test(
      value.trim()
    )
  ) {
    throw new AppError(
      `${label} must be in HH:mm format`,
      400,
      "INVALID_BOOKING_TIME"
    );
  }

  return value.trim();
};

const parseTimeToMinutes = (
  value: string
) => {
  const [
    hour = 0,
    minute = 0,
  ] = value.split(":").map(Number);

  return hour * 60 + minute;
};

const normalizePositiveInteger = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
) => {
  const parsed =
    typeof value === "number"
      ? value
      : Number(value);

  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed)
  ) {
    throw new AppError(
      `${label} must be a whole number`,
      400,
      "INVALID_BOOKING_SETTINGS"
    );
  }

  if (
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new AppError(
      `${label} must be between ${minimum} and ${maximum}`,
      400,
      "INVALID_BOOKING_SETTINGS"
    );
  }

  return parsed;
};

const normalizeDateKey = (
  value: unknown
) => {
  if (typeof value !== "string") {
    throw new AppError(
      "Closure date must be a string in YYYY-MM-DD format",
      400,
      "INVALID_BOOKING_CLOSURE"
    );
  }

  const trimmed = value.trim();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      trimmed
    )
  ) {
    throw new AppError(
      "Closure date must be in YYYY-MM-DD format",
      400,
      "INVALID_BOOKING_CLOSURE"
    );
  }

  return trimmed;
};

export type BranchBookingSettingsPayload = {
  timezone?: string;
  openingTime?: string;
  closingTime?: string;
  slotIntervalMinutes?: number;
  minLeadMinutes?: number;
  maxAdvanceDays?: number;
  allowBookings?: boolean;
  weeklyOffDays?: Weekday[];
  closedMessage?: string | null;
};

export type BranchBookingClosurePayload = {
  dateKey: string;
  reason?: string | null;
  isClosed?: boolean;
};

export const sanitizeBranchBookingSettingsInput = (
  input: BranchBookingSettingsPayload
) => {
  const timezone =
    typeof input.timezone === "string" &&
    input.timezone.trim()
      ? input.timezone.trim()
      : DEFAULT_BRANCH_BOOKING_SETTINGS.timezone;

  const openingTime =
    normalizeTimeValue(
      input.openingTime ??
        DEFAULT_BRANCH_BOOKING_SETTINGS.openingTime,
      "Opening time"
    );

  const closingTime =
    normalizeTimeValue(
      input.closingTime ??
        DEFAULT_BRANCH_BOOKING_SETTINGS.closingTime,
      "Closing time"
    );

  if (
    parseTimeToMinutes(
      closingTime
    ) <=
    parseTimeToMinutes(
      openingTime
    )
  ) {
    throw new AppError(
      "Closing time must be later than opening time",
      400,
      "INVALID_BOOKING_HOURS"
    );
  }

  const slotIntervalMinutes =
    normalizePositiveInteger(
      input.slotIntervalMinutes ??
        DEFAULT_BRANCH_BOOKING_SETTINGS.slotIntervalMinutes,
      "Slot interval",
      15,
      240
    );

  const minLeadMinutes =
    normalizePositiveInteger(
      input.minLeadMinutes ??
        DEFAULT_BRANCH_BOOKING_SETTINGS.minLeadMinutes,
      "Minimum lead time",
      0,
      1440
    );

  const maxAdvanceDays =
    normalizePositiveInteger(
      input.maxAdvanceDays ??
        DEFAULT_BRANCH_BOOKING_SETTINGS.maxAdvanceDays,
      "Advance booking window",
      1,
      180
    );

  const allowBookings =
    typeof input.allowBookings ===
    "boolean"
      ? input.allowBookings
      : DEFAULT_BRANCH_BOOKING_SETTINGS.allowBookings;

  const weeklyOffDays = Array.isArray(
    input.weeklyOffDays
  )
    ? Array.from(
        new Set(
          input.weeklyOffDays.filter(
            (value): value is Weekday =>
              typeof value === "string" &&
              value in WEEKDAY_LABELS
          )
        )
      )
    : DEFAULT_BRANCH_BOOKING_SETTINGS.weeklyOffDays;

  const closedMessage =
    typeof input.closedMessage === "string"
      ? input.closedMessage.trim() || null
      : null;

  return {
    timezone,
    openingTime,
    closingTime,
    slotIntervalMinutes,
    minLeadMinutes,
    maxAdvanceDays,
    allowBookings,
    weeklyOffDays,
    closedMessage,
  };
};

export const sanitizeBranchBookingClosuresInput = (
  closures: BranchBookingClosurePayload[]
) => {
  if (!Array.isArray(closures)) {
    throw new AppError(
      "closures must be an array",
      400,
      "INVALID_BOOKING_CLOSURE"
    );
  }

  const seen = new Set<string>();

  return closures
    .map((closure) => {
      const dateKey = normalizeDateKey(
        closure?.dateKey
      );

      if (seen.has(dateKey)) {
        throw new AppError(
          `Duplicate closure date: ${dateKey}`,
          400,
          "DUPLICATE_BOOKING_CLOSURE"
        );
      }

      seen.add(dateKey);

      return {
        dateKey,
        reason:
          typeof closure.reason ===
          "string"
            ? closure.reason.trim() || null
            : null,
        isClosed:
          typeof closure.isClosed ===
          "boolean"
            ? closure.isClosed
            : true,
      };
    })
    .filter((closure) => closure.isClosed);
};

export const getOrCreateBranchBookingSettings =
  async (branchId: string) =>
    prisma.branchBookingSettings.upsert({
      where: { branchId },
      update: {},
      create: {
        branchId,
        ...DEFAULT_BRANCH_BOOKING_SETTINGS,
      },
    });

export const getBranchBookingScheduleById =
  async (branchId: string) => {
    const branch =
      await prisma.branch.findFirst({
        where: {
          id: branchId,
          deletedAt: null,
        },
        include: {
          city: true,
          bookingSettings: true,
          bookingClosures: {
            where: { isClosed: true },
            orderBy: {
              dateKey: "asc",
            },
          },
        },
      });

    if (!branch) {
      throw new AppError(
        "Branch not found",
        404,
        "BRANCH_NOT_FOUND"
      );
    }

    const settings =
      branch.bookingSettings ??
      (await getOrCreateBranchBookingSettings(
        branchId
      ));

    return {
      branch,
      settings,
      closures: branch.bookingClosures,
    };
  };

const getTodayStatus = ({
  settings,
  closures,
}: {
  settings: BranchBookingSettings;
  closures: BranchBookingClosure[];
}) => {
  const now = new Date();
  const timezone =
    settings.timezone ||
    DEFAULT_BRANCH_BOOKING_SETTINGS.timezone;
  const todayKey =
    getDateKeyInTimezone(
      now,
      timezone
    );
  const todayClosure = closures.find(
    (closure) =>
      closure.dateKey === todayKey &&
      closure.isClosed
  );
  const todayWeekday =
    getWeekdayInTimezone(
      now,
      timezone
    );

  return {
    dateKey: todayKey,
    weekday: todayWeekday,
    isClosed:
      !settings.allowBookings ||
      Boolean(todayClosure) ||
      settings.weeklyOffDays.includes(
        todayWeekday
      ),
    reason:
      todayClosure?.reason ??
      (!settings.allowBookings
        ? settings.closedMessage ??
          "Bookings are currently unavailable for this branch."
        : settings.weeklyOffDays.includes(
            todayWeekday
          )
        ? `${WEEKDAY_LABELS[todayWeekday]} is a weekly off.`
        : null),
  };
};

export const serializeBranchBookingSchedule =
  ({
    branch,
    settings,
    closures,
  }: {
    branch: Branch & {
      city: {
        id: string;
        name: string;
        state: string;
        country: string;
      };
    };
    settings: BranchBookingSettings;
    closures: BranchBookingClosure[];
  }) => ({
    branch: {
      id: branch.id,
      name: branch.name,
      city: branch.city,
      isActive: branch.isActive,
    },
    settings: {
      timezone: settings.timezone,
      openingTime: settings.openingTime,
      closingTime: settings.closingTime,
      slotIntervalMinutes:
        settings.slotIntervalMinutes,
      minLeadMinutes:
        settings.minLeadMinutes,
      maxAdvanceDays:
        settings.maxAdvanceDays,
      allowBookings:
        settings.allowBookings,
      weeklyOffDays:
        settings.weeklyOffDays,
      weeklyOffLabels:
        settings.weeklyOffDays.map(
          (day) =>
            WEEKDAY_LABELS[day]
        ),
      closedMessage:
        settings.closedMessage,
    },
    closures: closures.map((closure) => ({
      id: closure.id,
      dateKey: closure.dateKey,
      reason: closure.reason,
      isClosed: closure.isClosed,
    })),
    today: getTodayStatus({
      settings,
      closures,
    }),
    serverNow: new Date().toISOString(),
  });

export const replaceBranchBookingSchedule =
  async ({
    branchId,
    settings,
    closures,
  }: {
    branchId: string;
    settings: BranchBookingSettingsPayload;
    closures: BranchBookingClosurePayload[];
  }) => {
    const normalizedSettings =
      sanitizeBranchBookingSettingsInput(
        settings
      );
    const normalizedClosures =
      sanitizeBranchBookingClosuresInput(
        closures
      );

    await prisma.$transaction(
      async (tx) => {
        await tx.branchBookingSettings.upsert(
          {
            where: { branchId },
            update: normalizedSettings,
            create: {
              branchId,
              ...normalizedSettings,
            },
          }
        );

        await tx.branchBookingClosure.deleteMany(
          {
            where: {
              branchId,
              dateKey: {
                notIn:
                  normalizedClosures.map(
                    (closure) =>
                      closure.dateKey
                  ),
              },
            },
          }
        );

        for (const closure of normalizedClosures) {
          await tx.branchBookingClosure.upsert(
            {
              where: {
                branchId_dateKey: {
                  branchId,
                  dateKey:
                    closure.dateKey,
                },
              },
              update: {
                reason:
                  closure.reason,
                isClosed:
                  closure.isClosed,
              },
              create: {
                branchId,
                dateKey:
                  closure.dateKey,
                reason:
                  closure.reason,
                isClosed:
                  closure.isClosed,
              },
            }
          );
        }
      }
    );

    return getBranchBookingScheduleById(
      branchId
    );
  };

export const validateBranchScheduledAt =
  async ({
    branchId,
    scheduledAt,
  }: {
    branchId: string;
    scheduledAt: Date;
  }) => {
    const {
      settings,
      closures,
    } =
      await getBranchBookingScheduleById(
        branchId
      );

    if (!settings.allowBookings) {
      throw new AppError(
        settings.closedMessage ||
          "Bookings are temporarily unavailable for this branch.",
        400,
        "BOOKING_CLOSED"
      );
    }

    const now = new Date();
    const leadMs =
      settings.minLeadMinutes *
      60 *
      1000;

    if (
      scheduledAt.getTime() <
      now.getTime() + leadMs
    ) {
      throw new AppError(
        `Bookings must be scheduled at least ${settings.minLeadMinutes} minutes in advance.`,
        400,
        "BOOKING_LEAD_TIME"
      );
    }

    const maxAdvanceMs =
      settings.maxAdvanceDays *
      24 *
      60 *
      60 *
      1000;

    if (
      scheduledAt.getTime() >
      now.getTime() + maxAdvanceMs
    ) {
      throw new AppError(
        `Bookings can only be scheduled up to ${settings.maxAdvanceDays} days in advance.`,
        400,
        "BOOKING_TOO_FAR"
      );
    }

    const timezone =
      settings.timezone ||
      DEFAULT_BRANCH_BOOKING_SETTINGS.timezone;
    const scheduledDateKey =
      getDateKeyInTimezone(
        scheduledAt,
        timezone
      );
    const scheduledWeekday =
      getWeekdayInTimezone(
        scheduledAt,
        timezone
      );
    const scheduledMinutes =
      getMinutesInTimezone(
        scheduledAt,
        timezone
      );
    const openingMinutes =
      parseTimeToMinutes(
        settings.openingTime
      );
    const closingMinutes =
      parseTimeToMinutes(
        settings.closingTime
      );

    if (
      settings.weeklyOffDays.includes(
        scheduledWeekday
      )
    ) {
      throw new AppError(
        `${WEEKDAY_LABELS[scheduledWeekday]} is a weekly off for this branch.`,
        400,
        "BOOKING_WEEKLY_OFF"
      );
    }

    const closure = closures.find(
      (item) =>
        item.isClosed &&
        item.dateKey ===
          scheduledDateKey
    );

    if (closure) {
      throw new AppError(
        closure.reason ||
          "This branch is closed for bookings on the selected date.",
        400,
        "BOOKING_DATE_CLOSED"
      );
    }

    if (
      scheduledMinutes < openingMinutes ||
      scheduledMinutes > closingMinutes
    ) {
      throw new AppError(
        `Bookings are only available between ${settings.openingTime} and ${settings.closingTime}.`,
        400,
        "BOOKING_OUTSIDE_HOURS"
      );
    }

    return {
      settings,
      closures,
      scheduledDateKey,
      scheduledWeekday,
    };
  };
