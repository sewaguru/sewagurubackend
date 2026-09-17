import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";

//////////////////////////////////////////////////////
// STALENESS
//////////////////////////////////////////////////////
// A location older than this should not be treated as "current" by any
// future nearby-dispatch query. Chosen generously relative to the
// LOCATION_UPDATE rate limit (~1 ping/5s while foregrounded) so a few
// missed pings from a brief network drop don't flip a professional stale.
export const LOCATION_STALE_AFTER_MS = 5 * 60 * 1000;

export const isLocationStale = (
  locationUpdatedAt: Date | null | undefined
) => {
  if (!locationUpdatedAt) {
    return true;
  }

  return (
    Date.now() - new Date(locationUpdatedAt).getTime() >
    LOCATION_STALE_AFTER_MS
  );
};

//////////////////////////////////////////////////////
// READ / WRITE CHOKEPOINTS
//////////////////////////////////////////////////////
// Every location read/write in the app goes through these two functions.
// Swapping to PostGIS or mirroring into Redis GEO later means changing
// these two implementations only — no dispatch or controller code should
// ever touch ProfessionalProfile.latitude/longitude directly.

export type ProfessionalLocationView = {
  latitude: number | null;
  longitude: number | null;
  locationUpdatedAt: Date | null;
  serviceRadiusKm: number;
  isStale: boolean;
};

export const getLocationView = (profile: {
  latitude: number | null;
  longitude: number | null;
  locationUpdatedAt: Date | null;
  serviceRadiusKm: number;
}): ProfessionalLocationView => ({
  latitude: profile.latitude,
  longitude: profile.longitude,
  locationUpdatedAt: profile.locationUpdatedAt,
  serviceRadiusKm: profile.serviceRadiusKm,
  isStale: isLocationStale(profile.locationUpdatedAt),
});

export const updateProfessionalLocation = async ({
  professionalId,
  latitude,
  longitude,
}: {
  professionalId: string;
  latitude: number;
  longitude: number;
}) => {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new AppError(
      "latitude must be a number between -90 and 90",
      400,
      "INVALID_LATITUDE"
    );
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new AppError(
      "longitude must be a number between -180 and 180",
      400,
      "INVALID_LONGITUDE"
    );
  }

  return prisma.professionalProfile.update({
    where: { id: professionalId },
    data: {
      latitude,
      longitude,
      locationUpdatedAt: new Date(),
    },
  });
};
