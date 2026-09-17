const EARTH_RADIUS_M = 6371000;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Compass bearing (0-360, 0 = north) of travel from point 1 to point 2.
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

// Smallest angle (0-180) between two compass bearings.
export function angleDiffDegrees(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function boundingBox(lat1, lon1, lat2, lon2, paddingRatio = 0.4, minPaddingDeg = 0.02, maxSpanDeg = 0.6) {
  const minLat = Math.min(lat1, lat2);
  const maxLat = Math.max(lat1, lat2);
  const minLon = Math.min(lon1, lon2);
  const maxLon = Math.max(lon1, lon2);

  const latSpan = Math.max(maxLat - minLat, 0.001);
  const lonSpan = Math.max(maxLon - minLon, 0.001);

  const latPad = Math.min(Math.max(latSpan * paddingRatio, minPaddingDeg), maxSpanDeg);
  const lonPad = Math.min(Math.max(lonSpan * paddingRatio, minPaddingDeg), maxSpanDeg);

  return {
    south: minLat - latPad,
    west: minLon - lonPad,
    north: maxLat + latPad,
    east: maxLon + lonPad,
  };
}
