// Pure geometry helpers for real-time turn-by-turn navigation: projecting a live
// GPS fix onto the route polyline and deriving progress from it (distance to the
// next maneuver, distance remaining, whether the fix has drifted off the route).
// No DOM/browser APIs here on purpose, so this can be unit-tested with plain Node
// and reused as-is from app.js.

const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Compass bearing (degrees clockwise from true north, 0-360) from point 1 to point 2.
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLon = toRad(lon2 - lon1);
  const y = Math.sin(deltaLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

// Projects (lat, lon) onto the closest point of segment [a, b] (coords as [lon, lat]).
// Uses a local equirectangular approximation - accurate enough at street scale.
function projectOntoSegment(lat, lon, a, b) {
  const cosLat = Math.cos(toRad((a[1] + b[1]) / 2));
  const toXY = (pt) => [pt[0] * cosLat, pt[1]];
  const p = toXY([lon, lat]);
  const pa = toXY(a);
  const pb = toXY(b);
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projLon = a[0] + t * (b[0] - a[0]);
  const projLat = a[1] + t * (b[1] - a[1]);
  return { point: [projLon, projLat], t, distanceMeters: haversineMeters(lat, lon, projLat, projLon) };
}

/**
 * Finds the closest point on the whole route polyline to (lat, lon).
 * coordinates: [[lon, lat], ...]
 * Returns { point, distanceMeters, distanceAlongRouteMeters } where
 * distanceAlongRouteMeters is the cumulative route distance from the start up to
 * the projected point.
 */
export function projectOntoRoute(lat, lon, coordinates) {
  let best = null;
  let cumulative = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = coordinates[i];
    const b = coordinates[i + 1];
    const segLen = haversineMeters(a[1], a[0], b[1], b[0]);
    const proj = projectOntoSegment(lat, lon, a, b);
    const distanceAlongRouteMeters = cumulative + proj.t * segLen;
    if (!best || proj.distanceMeters < best.distanceMeters) {
      best = { point: proj.point, distanceMeters: proj.distanceMeters, distanceAlongRouteMeters };
    }
    cumulative += segLen;
  }
  return best;
}

// Cumulative distance (meters) from the route start to each coordinate index.
export function cumulativeDistances(coordinates) {
  const distances = [0];
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = coordinates[i];
    const b = coordinates[i + 1];
    distances.push(distances[i] + haversineMeters(a[1], a[0], b[1], b[0]));
  }
  return distances;
}

/**
 * For each maneuver, finds how far along the route (in meters from the start) it
 * occurs, by matching its coordinate to the nearest route coordinate index.
 */
export function maneuverDistancesAlongRoute(coordinates, maneuvers) {
  const cumDist = cumulativeDistances(coordinates);
  return maneuvers.map((m) => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coordinates.length; i++) {
      const d = haversineMeters(m.coordinate[1], m.coordinate[0], coordinates[i][1], coordinates[i][0]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return cumDist[bestIdx];
  });
}

export const OFF_ROUTE_THRESHOLD_METERS = 40;
export const MANEUVER_ARRIVAL_THRESHOLD_METERS = 25;

/**
 * Computes live navigation progress for the given GPS fix against a route.
 * route: { coordinates, distanceMeters }
 * maneuverDistances: from maneuverDistancesAlongRoute() - passed in so callers
 * compute it once per route rather than on every GPS update.
 */
export function computeProgress(lat, lon, route, maneuverDistances) {
  const projection = projectOntoRoute(lat, lon, route.coordinates);
  const isOffRoute = projection.distanceMeters > OFF_ROUTE_THRESHOLD_METERS;

  // The active maneuver is the next upcoming one whose position along the route
  // we haven't essentially reached yet (small tolerance so we advance once we're
  // at/through it, rather than waiting for an exact coordinate match).
  let activeIndex = maneuverDistances.length - 1;
  for (let i = 0; i < maneuverDistances.length; i++) {
    if (projection.distanceAlongRouteMeters < maneuverDistances[i] - MANEUVER_ARRIVAL_THRESHOLD_METERS) {
      activeIndex = i;
      break;
    }
  }

  const distanceToManeuverMeters = Math.max(0, Math.round(maneuverDistances[activeIndex] - projection.distanceAlongRouteMeters));
  const distanceRemainingMeters = Math.max(0, Math.round(route.distanceMeters - projection.distanceAlongRouteMeters));

  // Arrival is checked against the actual destination coordinate directly, not
  // via the route projection: far off-route, the projection can clamp to the
  // last segment's endpoint and make distanceRemainingMeters look like ~0 even
  // when the real GPS fix is nowhere near the destination.
  const lastCoord = route.coordinates[route.coordinates.length - 1];
  const distanceToDestinationMeters = haversineMeters(lat, lon, lastCoord[1], lastCoord[0]);
  const hasArrived = distanceToDestinationMeters <= MANEUVER_ARRIVAL_THRESHOLD_METERS;

  return {
    isOffRoute,
    distanceFromRouteMeters: Math.round(projection.distanceMeters),
    activeManeuverIndex: activeIndex,
    distanceToManeuverMeters,
    distanceRemainingMeters,
    hasArrived,
  };
}
