import { haversineMeters } from "./geo.js";

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

/**
 * Builds a directed graph from raw OSM nodes/ways.
 * Returns { adjacency: Map<nodeId, Edge[]>, nodes: Map<nodeId, NodeInfo> }
 * Edge = { to, distance, timeSec, isSignalEntry }
 */
export function buildGraph({ nodes, ways }) {
  const adjacency = new Map();

  const addEdge = (fromId, toId, tags) => {
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to) return;

    const distance = haversineMeters(from.lat, from.lon, to.lat, to.lon);
    if (distance === 0) return;

    const speedKmh = speedForHighway(tags.highway);
    const timeSec = (distance / 1000 / speedKmh) * 3600;

    if (!adjacency.has(fromId)) adjacency.set(fromId, []);
    adjacency.get(fromId).push({
      to: toId,
      distance,
      timeSec,
      isSignalEntry: Boolean(to.isTrafficSignal),
    });
  };

  for (const way of ways) {
    const direction = isOneway(way.tags);
    const nodeIds = way.nodeIds;

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const a = nodeIds[i];
      const b = nodeIds[i + 1];

      if (direction !== "backward") addEdge(a, b, way.tags);
      if (direction !== "forward") addEdge(b, a, way.tags);
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
