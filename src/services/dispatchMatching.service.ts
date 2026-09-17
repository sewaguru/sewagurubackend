import { prisma } from "../lib/prisma";
import { config } from "../config/config";
import { calculateDistanceKm } from "../utils/geo.util";
import { isLocationStale } from "./professionalLocation.service";

//////////////////////////////////////////////////////
// PURE MATCHING / RANKING (no writes, safe to call repeatedly)
//////////////////////////////////////////////////////
// This is the one place that decides "who is eligible for this booking
// right now." Swapping the distance/candidate-selection strategy for
// PostGIS or Redis GEO later means changing this file only.
//////////////////////////////////////////////////////

export type EligibleProfessionalCandidate = {
  professionalId: string;
  userId: string;
  distanceKm: number;
  averageRating: number | null;
  ratingCount: number;
  createdAt: Date;
};

const rankCandidates = (
  candidates: EligibleProfessionalCandidate[]
) =>
  [...candidates].sort((a, b) => {
    if (a.distanceKm !== b.distanceKm) {
      return a.distanceKm - b.distanceKm;
    }

    const ratingA = a.averageRating ?? -1;
    const ratingB = b.averageRating ?? -1;
    if (ratingA !== ratingB) {
      return ratingB - ratingA;
    }

    if (a.ratingCount !== b.ratingCount) {
      return b.ratingCount - a.ratingCount;
    }

    return a.createdAt.getTime() - b.createdAt.getTime();
  });

//////////////////////////////////////////////////////
// SCHEDULE CONFLICT (shared by matching and job-offer acceptance)
//////////////////////////////////////////////////////

export const findProfessionalIdsWithSchedulingConflict = async ({
  professionalIds,
  scheduledAt,
  excludeBookingId,
}: {
  professionalIds: string[];
  scheduledAt: Date;
  excludeBookingId: string;
}): Promise<Set<string>> => {
  if (professionalIds.length === 0) {
    return new Set();
  }

  const conflictWindowMs =
    config.DISPATCH_SCHEDULE_CONFLICT_BUFFER_MINUTES * 60 * 1000;
  const windowStart = new Date(scheduledAt.getTime() - conflictWindowMs);
  const windowEnd = new Date(scheduledAt.getTime() + conflictWindowMs);

  const conflictingBookings = await prisma.booking.findMany({
    where: {
      assignedProfessionalId: { in: professionalIds },
      id: { not: excludeBookingId },
      isActive: true,
      status: { notIn: ["CANCELLED", "COMPLETED"] },
      scheduledAt: { gte: windowStart, lte: windowEnd },
    },
    select: { assignedProfessionalId: true },
  });

  return new Set(
    conflictingBookings
      .map((b) => b.assignedProfessionalId)
      .filter((id): id is string => Boolean(id))
  );
};

export const findEligibleProfessionalsForBooking = async (
  bookingId: string
): Promise<EligibleProfessionalCandidate[]> => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      isActive: true,
      scheduledAt: true,
      assignedProfessionalId: true,
      address: { select: { latitude: true, longitude: true } },
      items: { select: { serviceNodeId: true } },
    },
  });

  if (
    !booking ||
    !booking.isActive ||
    booking.assignedProfessionalId ||
    booking.status === "CANCELLED" ||
    !booking.address
  ) {
    return [];
  }

  const requestedServiceNodeIds = [
    ...new Set(
      booking.items
        .map((item) => item.serviceNodeId)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  if (requestedServiceNodeIds.length === 0) {
    return [];
  }

  // A professional who already has any offer row for this booking (sent,
  // viewed, accepted, rejected, expired, cancelled) must never be offered
  // it again — this is also what makes re-dispatch naturally advance to
  // the next batch instead of re-selecting the same people.
  const alreadyOffered = await prisma.bookingProfessionalOffer.findMany({
    where: { bookingId },
    select: { professionalId: true },
  });
  const excludedIds = alreadyOffered.map((o) => o.professionalId);

  const rawCandidates = await prisma.professionalProfile.findMany({
    where: {
      ...(excludedIds.length ? { id: { notIn: excludedIds } } : {}),
      verificationStatus: "APPROVED",
      availabilityStatus: "ONLINE",
      isActive: true,
      deletedAt: null,
      latitude: { not: null },
      longitude: { not: null },
      services: {
        some: {
          serviceNodeId: { in: requestedServiceNodeIds },
          isActive: true,
          serviceNode: { isActive: true, deletedAt: null },
        },
      },
    },
    select: {
      id: true,
      userId: true,
      latitude: true,
      longitude: true,
      locationUpdatedAt: true,
      serviceRadiusKm: true,
      averageRating: true,
      ratingCount: true,
      createdAt: true,
      services: {
        where: {
          isActive: true,
          serviceNode: { isActive: true, deletedAt: null },
        },
        select: { serviceNodeId: true },
      },
    },
  });

  // "Covers all requested services", not just "covers at least one" — the
  // DB query above can only pre-filter on "some", so the superset check
  // happens here.
  const coversAllServices = rawCandidates.filter((candidate) => {
    const offered = new Set(
      candidate.services.map((s) => s.serviceNodeId)
    );
    return requestedServiceNodeIds.every((id) => offered.has(id));
  });

  const withFreshLocation = coversAllServices.filter(
    (candidate) => !isLocationStale(candidate.locationUpdatedAt)
  );

  const withinRadius = withFreshLocation
    .map((candidate) => {
      const distanceKm = calculateDistanceKm(
        {
          latitude: candidate.latitude!,
          longitude: candidate.longitude!,
        },
        {
          latitude: booking.address!.latitude,
          longitude: booking.address!.longitude,
        }
      );

      const maxRadiusKm = Math.min(
        config.DISPATCH_MAX_RADIUS_KM,
        Math.max(0, candidate.serviceRadiusKm)
      );

      return { candidate, distanceKm, maxRadiusKm };
    })
    .filter(({ distanceKm, maxRadiusKm }) => distanceKm <= maxRadiusKm);

  if (withinRadius.length === 0) {
    return [];
  }

  //////////////////////////////////////////////////////
  // SCHEDULE CONFLICT CHECK
  //////////////////////////////////////////////////////
  const candidateIds = withinRadius.map(({ candidate }) => candidate.id);

  const conflictedIds = await findProfessionalIdsWithSchedulingConflict({
    professionalIds: candidateIds,
    scheduledAt: booking.scheduledAt,
    excludeBookingId: bookingId,
  });

  const eligible: EligibleProfessionalCandidate[] = withinRadius
    .filter(({ candidate }) => !conflictedIds.has(candidate.id))
    .map(({ candidate, distanceKm }) => ({
      professionalId: candidate.id,
      userId: candidate.userId,
      distanceKm,
      averageRating: candidate.averageRating,
      ratingCount: candidate.ratingCount,
      createdAt: candidate.createdAt,
    }));

  return rankCandidates(eligible);
};
