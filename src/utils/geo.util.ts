// Shared great-circle distance helper. Kept as a single, small, pure
// function precisely so it's replaceable with a PostGIS `ST_Distance`
// query or a Redis GEO lookup later without touching every call site.

export type GeoPoint = {
  latitude: number;
  longitude: number;
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export const calculateDistanceKm = (a: GeoPoint, b: GeoPoint) => {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const haversine =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  return earthRadiusKm * c;
};
