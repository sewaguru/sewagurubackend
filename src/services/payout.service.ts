import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { PayoutStatus, ProfessionalEarningStatus } from "../generated/prisma";

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

//////////////////////////////////////////////////////
// REQUEST PAYOUT (professional-initiated)
//////////////////////////////////////////////////////
// Foundation only — creates a PENDING Payout and reserves the covering
// PAYABLE earnings against it (by setting their payoutId). No automated
// bank transfer is triggered; an admin moves the payout through its
// lifecycle via updatePayoutStatusByAdmin.
//////////////////////////////////////////////////////

export const requestPayout = async ({
  professionalId,
  bankAccountId,
  amount,
}: {
  professionalId: string;
  bankAccountId: string;
  amount?: number;
}) => {
  const bankAccount = await prisma.professionalBankAccount.findFirst({
    where: { id: bankAccountId, professionalId },
  });

  if (!bankAccount) {
    throw new AppError(
      "Bank account not found.",
      404,
      "BANK_ACCOUNT_NOT_FOUND"
    );
  }

  const availableEarnings = await prisma.professionalEarning.findMany({
    where: {
      professionalId,
      status: ProfessionalEarningStatus.PAYABLE,
      payoutId: null,
    },
    orderBy: { createdAt: "asc" },
  });

  const availableTotal = roundMoney(
    availableEarnings.reduce((sum, e) => sum + e.netAmount, 0)
  );

  if (availableTotal <= 0) {
    throw new AppError(
      "No available balance to pay out.",
      400,
      "NO_AVAILABLE_BALANCE"
    );
  }

  const requestedAmount =
    amount !== undefined ? roundMoney(Number(amount)) : availableTotal;

  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    throw new AppError(
      "amount must be a positive number.",
      400,
      "INVALID_AMOUNT"
    );
  }

  if (requestedAmount > availableTotal) {
    throw new AppError(
      `Requested amount exceeds available balance of ${availableTotal}.`,
      400,
      "AMOUNT_EXCEEDS_BALANCE"
    );
  }

  // Cover the requested amount from the oldest available earnings first.
  const selectedIds: string[] = [];
  let runningTotal = 0;

  for (const earning of availableEarnings) {
    if (runningTotal >= requestedAmount) break;
    selectedIds.push(earning.id);
    runningTotal = roundMoney(runningTotal + earning.netAmount);
  }

  const payoutId = await prisma.$transaction(async (tx) => {
    const created = await tx.payout.create({
      data: {
        professionalId,
        bankAccountId,
        amount: runningTotal,
        status: PayoutStatus.PENDING,
      },
    });

    // Conditional guard (payoutId: null, status: PAYABLE) protects against
    // a concurrent second payout request racing to claim the same
    // earnings — whichever transaction commits first wins each row.
    const claimed = await tx.professionalEarning.updateMany({
      where: {
        id: { in: selectedIds },
        payoutId: null,
        status: ProfessionalEarningStatus.PAYABLE,
      },
      data: { payoutId: created.id },
    });

    if (claimed.count !== selectedIds.length) {
      throw new AppError(
        "Some of your available earnings were just claimed by another payout request. Please try again.",
        409,
        "EARNINGS_ALREADY_CLAIMED"
      );
    }

    return created.id;
  });

  return prisma.payout.findUniqueOrThrow({
    where: { id: payoutId },
    include: { earnings: true, bankAccount: true },
  });
};

//////////////////////////////////////////////////////
// ADMIN: ADVANCE PAYOUT STATUS
//////////////////////////////////////////////////////

const PAYOUT_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  PENDING: [],
  PROCESSING: [PayoutStatus.PENDING],
  PAID: [PayoutStatus.PENDING, PayoutStatus.PROCESSING],
  FAILED: [PayoutStatus.PENDING, PayoutStatus.PROCESSING],
  CANCELLED: [PayoutStatus.PENDING],
};

export const updatePayoutStatusByAdmin = async ({
  payoutId,
  status,
  reference,
  failureReason,
}: {
  payoutId: string;
  status: PayoutStatus;
  reference?: string | null;
  failureReason?: string | null;
}) => {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
  });

  if (!payout) {
    throw new AppError("Payout not found.", 404, "PAYOUT_NOT_FOUND");
  }

  if (payout.status === status) {
    return payout;
  }

  const allowedFrom = PAYOUT_TRANSITIONS[status] ?? [];

  if (!allowedFrom.includes(payout.status)) {
    throw new AppError(
      `Cannot move payout from ${payout.status} to ${status}.`,
      409,
      "INVALID_PAYOUT_TRANSITION"
    );
  }

  if (status === PayoutStatus.FAILED && !failureReason?.trim()) {
    throw new AppError(
      "failureReason is required when marking a payout as FAILED.",
      400,
      "REASON_REQUIRED"
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.payout.update({
      where: { id: payoutId },
      data: {
        status,
        reference:
          typeof reference === "string" ? reference.trim() : payout.reference,
        failureReason:
          status === PayoutStatus.FAILED
            ? failureReason!.trim()
            : null,
        processedAt:
          status === PayoutStatus.PAID || status === PayoutStatus.FAILED
            ? new Date()
            : payout.processedAt,
      },
    });

    if (status === PayoutStatus.PAID) {
      await tx.professionalEarning.updateMany({
        where: { payoutId },
        data: { status: ProfessionalEarningStatus.PAID },
      });
    } else if (
      status === PayoutStatus.FAILED ||
      status === PayoutStatus.CANCELLED
    ) {
      // Release the reserved earnings back to the available pool so the
      // professional can request a payout again.
      await tx.professionalEarning.updateMany({
        where: { payoutId },
        data: { payoutId: null },
      });
    }

    return result;
  });

  return updated;
};
