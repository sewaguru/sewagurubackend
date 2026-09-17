import { prisma } from "../lib/prisma";
import { ProfessionalEarningStatus } from "../generated/prisma";
import { getPlatformCommissionPercent } from "./platformSettings.service";

const log = (event: string, data?: Record<string, unknown>) => {
  console.log("[EARNINGS]", event, data ?? {});
};

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

//////////////////////////////////////////////////////
// ENSURE EARNING (idempotent chokepoint)
//////////////////////////////////////////////////////
// Called from every place a booking can become COMPLETED+paid — job
// completion, admin status override, and every payment-confirmation path
// (webhook, gateway status poll, lazy sync, admin manual payment update).
// Safe to call any number of times for the same booking: the first call
// that finds both preconditions true creates the row; every later call
// (duplicate completion event, retried webhook, etc.) finds the
// preconditions already satisfied and the upsert's `update: {}` makes it
// a true no-op — the existing row (and its already-computed amounts) is
// never touched, so a later commission-rate change never retroactively
// changes a past earning.
//////////////////////////////////////////////////////

export const ensureEarningForBooking = async (bookingId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      isActive: true,
      status: true,
      paymentStatus: true,
      assignedProfessionalId: true,
      subtotal: true,
      discountAmount: true,
    },
  });

  if (!booking || !booking.isActive) {
    return null;
  }

  if (booking.status !== "COMPLETED") {
    return null;
  }

  if (!booking.assignedProfessionalId) {
    // No professional was ever assigned (e.g. an admin marked an
    // unassigned booking COMPLETED directly) — nothing to pay out.
    return null;
  }

  // Money must actually be secured — either collected online (PAID) or
  // never required in the first place (NOT_REQUIRED, e.g. pay-later/cash
  // collected at the visit). PENDING/FAILED/REFUNDED never create an
  // earning; if payment later confirms, the payment-confirmation hooks
  // call this same function again and it proceeds then.
  if (
    booking.paymentStatus !== "PAID" &&
    booking.paymentStatus !== "NOT_REQUIRED"
  ) {
    return null;
  }

  const existing = await prisma.professionalEarning.findUnique({
    where: {
      professionalId_bookingId: {
        professionalId: booking.assignedProfessionalId,
        bookingId: booking.id,
      },
    },
  });

  if (existing) {
    return existing;
  }

  // Commission applies to the taxable base (subtotal less discount),
  // excluding tax — tax is a pass-through to the government, never split
  // with the professional.
  const grossAmount = roundMoney(
    Math.max(0, booking.subtotal - (booking.discountAmount ?? 0))
  );
  const commissionPercent = await getPlatformCommissionPercent();
  const platformFeeAmount = roundMoney(
    (grossAmount * commissionPercent) / 100
  );
  const netAmount = roundMoney(grossAmount - platformFeeAmount);

  try {
    const earning = await prisma.professionalEarning.upsert({
      where: {
        professionalId_bookingId: {
          professionalId: booking.assignedProfessionalId,
          bookingId: booking.id,
        },
      },
      // Never overwrite an already-created earning — idempotency by
      // construction, not just a pre-check.
      update: {},
      create: {
        professionalId: booking.assignedProfessionalId,
        bookingId: booking.id,
        grossAmount,
        platformFeeAmount,
        netAmount,
        status: ProfessionalEarningStatus.PAYABLE,
      },
    });

    log("EARNING_CREATED", {
      bookingId: booking.id,
      professionalId: booking.assignedProfessionalId,
      grossAmount,
      platformFeeAmount,
      netAmount,
      commissionPercent,
    });

    return earning;
  } catch (error) {
    // A concurrent duplicate call raced us to the same upsert — the
    // unique constraint guarantees only one row exists either way.
    console.error("[EARNINGS] ENSURE_EARNING_FAILED", {
      bookingId: booking.id,
      error,
    });
    return prisma.professionalEarning.findUnique({
      where: {
        professionalId_bookingId: {
          professionalId: booking.assignedProfessionalId,
          bookingId: booking.id,
        },
      },
    });
  }
};

//////////////////////////////////////////////////////
// BALANCE / SUMMARY (self-scoped reads)
//////////////////////////////////////////////////////

export const getAvailableBalance = async (professionalId: string) => {
  const [availableAgg, lifetimePaidAgg, pendingPayoutAgg] =
    await Promise.all([
      prisma.professionalEarning.aggregate({
        where: {
          professionalId,
          status: ProfessionalEarningStatus.PAYABLE,
          payoutId: null,
        },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),
      prisma.professionalEarning.aggregate({
        where: {
          professionalId,
          status: ProfessionalEarningStatus.PAID,
        },
        _sum: { netAmount: true },
      }),
      prisma.payout.aggregate({
        where: {
          professionalId,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        _sum: { amount: true },
      }),
    ]);

  return {
    availableAmount: availableAgg._sum.netAmount ?? 0,
    availableEarningsCount: availableAgg._count._all,
    lifetimePaidAmount: lifetimePaidAgg._sum.netAmount ?? 0,
    pendingPayoutAmount: pendingPayoutAgg._sum.amount ?? 0,
  };
};

export const getEarningsSummaryForProfessional = async (
  professionalId: string
) => {
  const groups = await prisma.professionalEarning.groupBy({
    by: ["status"],
    where: { professionalId },
    _sum: { grossAmount: true, platformFeeAmount: true, netAmount: true },
    _count: { _all: true },
  });

  const byStatus: Record<
    string,
    { count: number; grossAmount: number; netAmount: number }
  > = {};

  let totalGrossAmount = 0;
  let totalPlatformFeeAmount = 0;
  let totalNetAmount = 0;
  let totalCount = 0;

  for (const group of groups) {
    totalGrossAmount += group._sum.grossAmount ?? 0;
    totalPlatformFeeAmount += group._sum.platformFeeAmount ?? 0;
    totalNetAmount += group._sum.netAmount ?? 0;
    totalCount += group._count._all;

    byStatus[group.status] = {
      count: group._count._all,
      grossAmount: group._sum.grossAmount ?? 0,
      netAmount: group._sum.netAmount ?? 0,
    };
  }

  const balance = await getAvailableBalance(professionalId);

  return {
    totalGrossAmount,
    totalPlatformFeeAmount,
    totalNetAmount,
    totalCount,
    byStatus,
    balance,
  };
};
