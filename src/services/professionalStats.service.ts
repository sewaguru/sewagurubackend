import { prisma } from "../lib/prisma";
import { getEarningsSummaryForProfessional } from "./earnings.service";

const log = (event: string, data?: Record<string, unknown>) => {
  console.log("[PROFESSIONAL_STATS]", event, data ?? {});
};

//////////////////////////////////////////////////////
// RATING (cached on ProfessionalProfile — read on every dispatch ranking
// round across every candidate, so recomputing per-read would be the
// "expensive on every request" case the phase brief warns against.
// Recomputed here only when a review actually changes, via a full
// aggregate rather than incremental math, to avoid floating-point drift.)
//////////////////////////////////////////////////////

export const refreshProfessionalRating = async (
  professionalId: string
) => {
  const aggregate = await prisma.serviceReview.aggregate({
    where: { professionalId, isVisible: true },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const updated = await prisma.professionalProfile.update({
    where: { id: professionalId },
    data: {
      averageRating: aggregate._avg.rating,
      ratingCount: aggregate._count._all,
    },
    select: { id: true, averageRating: true, ratingCount: true },
  });

  log("RATING_REFRESHED", {
    professionalId,
    averageRating: updated.averageRating,
    ratingCount: updated.ratingCount,
  });

  return updated;
};

//////////////////////////////////////////////////////
// JOB OUTCOME COUNTERS (cached on ProfessionalProfile — a handful of
// well-defined write sites, single atomic increment each, no transaction
// needed since it's one UPDATE statement)
//////////////////////////////////////////////////////

export type JobOutcome = "COMPLETED" | "CANCELLED";

export const recordJobOutcome = async (
  professionalId: string,
  outcome: JobOutcome
) => {
  try {
    await prisma.professionalProfile.update({
      where: { id: professionalId },
      data:
        outcome === "COMPLETED"
          ? { totalJobsCompleted: { increment: 1 } }
          : { totalJobsCancelled: { increment: 1 } },
    });
  } catch (error) {
    console.error("[PROFESSIONAL_STATS] RECORD_JOB_OUTCOME_FAILED", {
      professionalId,
      outcome,
      error,
    });
  }
};

//////////////////////////////////////////////////////
// OFFER STATS (computed live — read only on an infrequent stats page,
// cheap indexed groupBy, no cache field needed or justified)
//////////////////////////////////////////////////////

const roundRate = (numerator: number, denominator: number) =>
  denominator > 0
    ? Math.round((numerator / denominator) * 1000) / 1000
    : 0;

export const getOfferStatsForProfessional = async (
  professionalId: string
) => {
  const groups = await prisma.bookingProfessionalOffer.groupBy({
    by: ["status"],
    where: { professionalId },
    _count: { _all: true },
  });

  const counts: Record<string, number> = {
    PENDING: 0,
    SENT: 0,
    VIEWED: 0,
    ACCEPTED: 0,
    REJECTED: 0,
    EXPIRED: 0,
    CANCELLED: 0,
  };

  let totalOffers = 0;
  for (const group of groups) {
    counts[group.status] = group._count._all;
    totalOffers += group._count._all;
  }

  const acceptedOffers = counts.ACCEPTED ?? 0;

  return {
    totalOffers,
    acceptedOffers,
    rejectedOffers: counts.REJECTED ?? 0,
    expiredOffers: counts.EXPIRED ?? 0,
    cancelledOffers: counts.CANCELLED ?? 0,
    pendingOffers:
      (counts.PENDING ?? 0) + (counts.SENT ?? 0) + (counts.VIEWED ?? 0),
    acceptanceRate: roundRate(acceptedOffers, totalOffers),
  };
};

//////////////////////////////////////////////////////
// COMPOSED STATISTICS (the one function both the professional's own
// endpoint and the admin detail endpoint call — one source of truth)
//////////////////////////////////////////////////////

export const getProfessionalStatistics = async (
  professionalId: string
) => {
  const [profile, totalAssignedJobs, offerStats, earnings] =
    await Promise.all([
      prisma.professionalProfile.findUnique({
        where: { id: professionalId },
        select: {
          totalJobsCompleted: true,
          totalJobsCancelled: true,
          averageRating: true,
          ratingCount: true,
        },
      }),
      prisma.booking.count({
        where: { assignedProfessionalId: professionalId },
      }),
      getOfferStatsForProfessional(professionalId),
      getEarningsSummaryForProfessional(professionalId),
    ]);

  const completedJobs = profile?.totalJobsCompleted ?? 0;
  const cancelledJobs = profile?.totalJobsCancelled ?? 0;

  return {
    jobs: {
      totalAssignedJobs,
      completedJobs,
      cancelledJobs,
      completionRate: roundRate(completedJobs, totalAssignedJobs),
      cancellationRate: roundRate(cancelledJobs, totalAssignedJobs),
    },
    offers: offerStats,
    rating: {
      averageRating: profile?.averageRating ?? null,
      ratingCount: profile?.ratingCount ?? 0,
    },
    earnings,
  };
};
