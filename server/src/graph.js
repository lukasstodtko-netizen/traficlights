import { haversineMeters, bearingDegrees, angleDiffDegrees } from "./geo.js";

// Rough free-flow speeds (km/h) used only to estimate travel time,
// not for the light-minimization objective itself.
const SPEED_BY_HIGHWAY = {
  motorway: 100,
  motorway_link: 60,
  trunk: 90,
  trunk_link: 50,
  primary: 65,
  primary_link: 40,
  secondary: 55,
  secondary_link: 35,
  tertiary: 50,
  tertiary_link: 30,
  unclassified: 40,
  residential: 30,
  living_street: 12,
  service: 15,
};

function speedForHighway(highway) {
  return SPEED_BY_HIGHWAY[highway] ?? 40;
}

function isOneway(tags) {
  if (tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "true") return "forward";
  if (tags.oneway === "-1") return "backward";
  // Motorways are effectively oneway per carriageway even when untagged.
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return "forward";
  return null;
}

// OSM sometimes marks which approach a traffic signal actually controls, via
// traffic_signals:direction (falls back to the generic direction tag): "forward"/
// "backward" relative to the way's node order, "both", or a compass bearing in
// degrees. Without such a tag, the signal is assumed to face every approach - the
// normal case for a simple junction with one signal head per direction that OSM
// only mapped as a single node.
function signalAppliesToDirection(nodeTags, travelDirection, approachBearing) {
  const raw = nodeTags["traffic_signals:direction"] ?? nodeTags.direction;
  if (raw === undefined) return true;

  if (raw === "both") return true;
  if (raw === "forward") return travelDirection === "forward";
  if (raw === "backward") return travelDirection === "backward";

  const bearing = Number(raw);
  if (Number.isFinite(bearing)) {
    // A signal facing a given compass bearing is seen by traffic travelling
    // roughly the same way; allow a generous +/-90 deg tolerance since exact
    // mapping precision varies.
    return angleDiffDegrees(approachBearing, bearing) <= 90;
  }

  // Unrecognized value - don't silently drop a real light, just count it.
  return true;
}

/**
 * Builds a directed graph from raw OSM nodes/ways.
 * Returns { adjacency: Map<nodeId, Edge[]>, nodes: Map<nodeId, NodeInfo> }
 * Edge = { to, distance, timeSec, isSignalEntry }
 */
export function buildGraph({ nodes, ways }) {
  const adjacency = new Map();

  const addEdge = (fromId, toId, tags, travelDirection) => {
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to) return;

    const distance = haversineMeters(from.lat, from.lon, to.lat, to.lon);
    if (distance === 0) return;

    const speedKmh = speedForHighway(tags.highway);
    const timeSec = (distance / 1000 / speedKmh) * 3600;

    let isSignalEntry = false;
    if (to.isTrafficSignal) {
      const approachBearing = bearingDegrees(from.lat, from.lon, to.lat, to.lon);
      isSignalEntry = signalAppliesToDirection(to.tags, travelDirection, approachBearing);
    }

    if (!adjacency.has(fromId)) adjacency.set(fromId, []);
    adjacency.get(fromId).push({
      to: toId,
      distance,
      timeSec,
      isSignalEntry,
    });
  };

  for (const way of ways) {
    const direction = isOneway(way.tags);
    const nodeIds = way.nodeIds;

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const a = nodeIds[i];
      const b = nodeIds[i + 1];

      if (direction !== "backward") addEdge(a, b, way.tags, "forward");
      if (direction !== "forward") addEdge(b, a, way.tags, "backward");
    }
  }

  return { adjacency, nodes };
}

export function findNearestNode(nodes, lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const node of nodes.values()) {
    const d = haversineMeters(lat, lon, node.lat, node.lon);
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }
  return best ? { node: best, distance: bestDist } : null;
}
