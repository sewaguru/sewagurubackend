import { Response } from "express";
import { Prisma } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { AuthRequest } from "../types/types";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { requireOwnProfessionalProfile } from "../services/professional.service";
import {
  getAvailableBalance,
  getEarningsSummaryForProfessional,
} from "../services/earnings.service";
import { requestPayout } from "../services/payout.service";

const assertAuthenticatedUser = (req: AuthRequest) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401);
  }
  return req.user;
};

const MAX_NOTE_LENGTH = 500;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// A plain interactive transaction's SELECT ... FOR UPDATE did not reliably
// serialize concurrent "first bank account" / "set primary" requests in
// testing (observed two rows ending up isPrimary: true under a genuine
// race). SERIALIZABLE isolation makes Postgres itself detect the write
// skew and abort the loser with P2034, which is retried a few times —
// Prisma's own documented pattern for exactly this class of race.
const runSerializable = async <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 5
): Promise<T> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      // Prisma's classic engine reports a serialization conflict as
      // PrismaClientKnownRequestError code P2034. With the @prisma/adapter-pg
      // driver adapter (used throughout this project — see src/lib/prisma.ts)
      // it instead surfaces as a raw driver error carrying Postgres's own
      // SQLSTATE 40001 ("could not serialize access due to read/write
      // dependencies among transactions") — recognized here by checking
      // both shapes rather than assuming the classic-engine one.
      const anyError = error as {
        code?: string;
        cause?: { originalCode?: string; kind?: string };
      };
      const isConflict =
        anyError?.code === "P2034" ||
        anyError?.cause?.originalCode === "40001" ||
        anyError?.cause?.kind === "TransactionWriteConflict";

      if (!isConflict || attempt === attempts) {
        throw error;
      }
    }
  }

  throw new AppError("Could not complete request, please retry.", 409);
};

const maskAccountNumber = (accountNumber: string) => {
  const digits = accountNumber.replace(/\s+/g, "");
  if (digits.length <= 4) return "****";
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
};

const toBankAccountView = (account: {
  id: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  bankName: string | null;
  upiId: string | null;
  isPrimary: boolean;
  isVerified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
}) => ({
  id: account.id,
  accountHolderName: account.accountHolderName,
  accountNumberMasked: maskAccountNumber(account.accountNumber),
  ifscCode: account.ifscCode,
  bankName: account.bankName,
  upiId: account.upiId,
  isPrimary: account.isPrimary,
  isVerified: account.isVerified,
  verifiedAt: account.verifiedAt,
  createdAt: account.createdAt,
});

//////////////////////////////////////////////////////
// EARNINGS
//////////////////////////////////////////////////////

export const getEarningsSummary = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const summary = await getEarningsSummaryForProfessional(profile.id);

    res.json(successResponse(summary, "Earnings summary fetched"));
  }
);

export const getBalance = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const balance = await getAvailableBalance(profile.id);

    res.json(successResponse(balance, "Balance fetched"));
  }
);

export const listMyEarnings = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const {
      status,
      page = "1",
      pageSize = "20",
    } = req.query as { status?: string; page?: string; pageSize?: string };

    const pageNum = Math.max(1, Number(page) || 1);
    const limit = Math.min(Math.max(1, Number(pageSize) || 20), 100);
    const skip = (pageNum - 1) * limit;

    const where = {
      professionalId: profile.id,
      ...(status ? { status: status as any } : {}),
    };

    const [total, earnings] = await Promise.all([
      prisma.professionalEarning.count({ where }),
      prisma.professionalEarning.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          booking: {
            select: {
              id: true,
              displayId: true,
              scheduledAt: true,
              totalAmount: true,
              items: {
                select: { serviceNode: { select: { name: true } } },
              },
            },
          },
        },
      }),
    ]);

    res.json(
      successResponse(earnings, "Earnings fetched", {
        page: pageNum,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit),
      })
    );
  }
);

export const getMyEarningById = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const id = getParam(req.params.id, "earningId");

    const earning = await prisma.professionalEarning.findFirst({
      where: { id, professionalId: profile.id },
      include: {
        booking: {
          select: {
            id: true,
            displayId: true,
            scheduledAt: true,
            totalAmount: true,
            status: true,
            items: {
              select: { serviceNode: { select: { name: true } } },
            },
          },
        },
        payout: {
          select: { id: true, status: true, processedAt: true },
        },
      },
    });

    if (!earning) {
      throw new AppError("Earning not found.", 404, "EARNING_NOT_FOUND");
    }

    res.json(successResponse(earning, "Earning details fetched"));
  }
);

//////////////////////////////////////////////////////
// BANK ACCOUNTS
//////////////////////////////////////////////////////

export const listMyBankAccounts = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const accounts = await prisma.professionalBankAccount.findMany({
      where: { professionalId: profile.id },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    });

    res.json(
      successResponse(accounts.map(toBankAccountView), "Bank accounts fetched")
    );
  }
);

export const addMyBankAccount = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const accountHolderName =
      typeof req.body?.accountHolderName === "string"
        ? req.body.accountHolderName.trim()
        : "";
    const accountNumber =
      typeof req.body?.accountNumber === "string"
        ? req.body.accountNumber.replace(/\s+/g, "")
        : "";
    const ifscCode =
      typeof req.body?.ifscCode === "string"
        ? req.body.ifscCode.trim().toUpperCase()
        : "";
    const bankName =
      typeof req.body?.bankName === "string"
        ? req.body.bankName.trim() || null
        : null;
    const upiId =
      typeof req.body?.upiId === "string"
        ? req.body.upiId.trim() || null
        : null;

    if (!accountHolderName) {
      throw new AppError("accountHolderName is required", 400);
    }

    if (!/^\d{9,18}$/.test(accountNumber)) {
      throw new AppError(
        "accountNumber must be 9-18 digits",
        400,
        "INVALID_ACCOUNT_NUMBER"
      );
    }

    if (!IFSC_PATTERN.test(ifscCode)) {
      throw new AppError(
        "ifscCode must be a valid IFSC code (e.g. SBIN0001234)",
        400,
        "INVALID_IFSC"
      );
    }

    // Phase 10 hardening: a plain count()-then-create() here raced under
    // concurrent "add my first bank account" requests — both could see
    // count === 0 and both end up isPrimary: true. See runSerializable's
    // comment for why SERIALIZABLE + retry is used instead of a row lock.
    const created = await runSerializable(async (tx) => {
      const existingCount = await tx.professionalBankAccount.count({
        where: { professionalId: profile.id },
      });

      return tx.professionalBankAccount.create({
        data: {
          professionalId: profile.id,
          accountHolderName,
          accountNumber,
          ifscCode,
          bankName,
          upiId,
          // First bank account is automatically primary.
          isPrimary: existingCount === 0,
        },
      });
    });

    res.json(
      successResponse(toBankAccountView(created), "Bank account added")
    );
  }
);

export const setPrimaryBankAccount = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const id = getParam(req.params.id, "bankAccountId");

    const account = await prisma.professionalBankAccount.findFirst({
      where: { id, professionalId: profile.id },
    });

    if (!account) {
      throw new AppError("Bank account not found.", 404);
    }

    // Same class of race as addMyBankAccount: two concurrent "set primary"
    // calls starting from zero current primaries (e.g. right after the
    // primary account was deleted) could both succeed independently and
    // leave two rows marked primary. Same SERIALIZABLE + retry fix.
    await runSerializable(async (tx) => {
      await tx.professionalBankAccount.updateMany({
        where: { professionalId: profile.id, isPrimary: true },
        data: { isPrimary: false },
      });

      await tx.professionalBankAccount.update({
        where: { id },
        data: { isPrimary: true },
      });
    });

    res.json(successResponse(null, "Primary bank account updated"));
  }
);

export const deleteMyBankAccount = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const id = getParam(req.params.id, "bankAccountId");

    const account = await prisma.professionalBankAccount.findFirst({
      where: { id, professionalId: profile.id },
    });

    if (!account) {
      throw new AppError("Bank account not found.", 404);
    }

    const payoutCount = await prisma.payout.count({
      where: { bankAccountId: id },
    });

    if (payoutCount > 0) {
      throw new AppError(
        "This bank account has payout history and cannot be removed.",
        409,
        "BANK_ACCOUNT_HAS_PAYOUTS"
      );
    }

    await prisma.professionalBankAccount.delete({ where: { id } });

    res.json(successResponse(null, "Bank account removed"));
  }
);

//////////////////////////////////////////////////////
// PAYOUTS
//////////////////////////////////////////////////////

export const listMyPayouts = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const payouts = await prisma.payout.findMany({
      where: { professionalId: profile.id },
      include: {
        bankAccount: {
          select: { id: true, bankName: true, accountNumber: true },
        },
        _count: { select: { earnings: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const formatted = payouts.map((p) => ({
      ...p,
      bankAccount: p.bankAccount
        ? {
            id: p.bankAccount.id,
            bankName: p.bankAccount.bankName,
            accountNumberMasked: maskAccountNumber(
              p.bankAccount.accountNumber
            ),
          }
        : null,
      earningsCount: p._count.earnings,
    }));

    res.json(successResponse(formatted, "Payouts fetched"));
  }
);

export const getMyPayoutById = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const id = getParam(req.params.id, "payoutId");

    const payout = await prisma.payout.findFirst({
      where: { id, professionalId: profile.id },
      include: {
        bankAccount: true,
        earnings: {
          include: {
            booking: {
              select: { id: true, displayId: true, scheduledAt: true },
            },
          },
        },
      },
    });

    if (!payout) {
      throw new AppError("Payout not found.", 404, "PAYOUT_NOT_FOUND");
    }

    res.json(
      successResponse(
        {
          ...payout,
          bankAccount: payout.bankAccount
            ? toBankAccountView(payout.bankAccount)
            : null,
        },
        "Payout details fetched"
      )
    );
  }
);

export const requestMyPayout = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const bankAccountId =
      typeof req.body?.bankAccountId === "string"
        ? req.body.bankAccountId
        : "";

    if (!bankAccountId) {
      throw new AppError("bankAccountId is required", 400);
    }

    const payout = await requestPayout({
      professionalId: profile.id,
      bankAccountId,
      ...(req.body?.amount !== undefined
        ? { amount: Number(req.body.amount) }
        : {}),
    });

    res.json(successResponse(payout, "Payout requested"));
  }
);
