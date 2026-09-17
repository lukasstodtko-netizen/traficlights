import { bearingDegrees } from "./geo.js";

// Large enough to dominate any realistic in-city distance/time difference,
// so minimizing (distance + LIGHT_PENALTY * lights) effectively minimizes
// lights first, and only uses distance as a tiebreaker among equal-light routes.
const LIGHT_PENALTY_METERS = 200000;

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].priority <= this.items[i].priority) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < n && this.items[l].priority < this.items[smallest].priority) smallest = l;
        if (r < n && this.items[r].priority < this.items[smallest].priority) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

// A turn restriction only applies to a specific (via node, the way you arrived on)
// pair, and either forbids one specific continuation ("no_...") or mandates one
// ("only_..." - every other continuation is then forbidden). The very first move
// of a route has no "arrived on" way yet, so nothing can restrict it.
function isTurnForbidden(restrictions, viaNodeId, arrivingWayId, nextWayId) {
  if (arrivingWayId == null) return false;
  const rule = restrictions.get(`${viaNodeId}|${arrivingWayId}`);
  if (!rule) return false;
  if (rule.type === "no") return rule.toWayId === nextWayId;
  return rule.toWayId !== nextWayId;
}

/**
 * Dijkstra over the adjacency graph, with state = (node, way arrived on) rather
 * than just node, so that turn restrictions (which depend on where you came from)
 * can be enforced. costFn(edge) -> number, must be >= 0.
 * Returns { path: nodeId[], edgesUsed: Edge[] } or null if unreachable.
 */
function dijkstra(adjacency, restrictions, startId, endId, costFn) {
  const startKey = `${startId}|start`;
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const visited = new Set();
  const heap = new MinHeap();
  heap.push({ key: startKey, nodeId: startId, wayId: null, priority: 0 });

  let endState = null;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (visited.has(cur.key)) continue;
    visited.add(cur.key);
    if (cur.nodeId === endId) {
      endState = cur;
      break;
    }

    const edges = adjacency.get(cur.nodeId);
    if (!edges) continue;

    for (const edge of edges) {
      if (isTurnForbidden(restrictions, cur.nodeId, cur.wayId, edge.wayId)) continue;

      const nextKey = `${edge.to}|${edge.wayId}`;
      if (visited.has(nextKey)) continue;

      const newDist = cur.priority + costFn(edge);
      if (newDist < (dist.get(nextKey) ?? Infinity)) {
        dist.set(nextKey, newDist);
        prev.set(nextKey, { fromKey: cur.key, fromNodeId: cur.nodeId, edge });
        heap.push({ key: nextKey, nodeId: edge.to, wayId: edge.wayId, priority: newDist });
      }
    }
  }

  if (!endState) return null;

  const path = [endId];
  const edgesUsed = [];
  let curKey = endState.key;
  while (curKey !== startKey) {
    const step = prev.get(curKey);
    if (!step) return null;
    edgesUsed.unshift(step.edge);
    path.unshift(step.fromNodeId);
    curKey = step.fromKey;
  }

  return { path, edgesUsed };
}

// Maneuvers are derived from OSM street-name changes along the route, which is
// the same simplification most hobby routers use - it doesn't capture every lane
// change, but it matches every point where a driver actually has to decide
// something ("this street ends, which way now").
const TURN_LABELS = {
  straight: "Continue straight",
  "slight-left": "Keep left",
  "slight-right": "Keep right",
  left: "Turn left",
  right: "Turn right",
  "sharp-left": "Sharp left",
  "sharp-right": "Sharp right",
};

function classifyTurn(bearingBefore, bearingAfter) {
  const diff = ((bearingAfter - bearingBefore + 540) % 360) - 180; // -180..180, + = right, - = left
  const abs = Math.abs(diff);
  if (abs < 20) return "straight";
  if (abs < 45) return diff > 0 ? "slight-right" : "slight-left";
  if (abs < 150) return diff > 0 ? "right" : "left";
  return diff > 0 ? "sharp-right" : "sharp-left";
}

function maneuverInstruction(turn, streetName) {
  const label = TURN_LABELS[turn] || "Continue";
  return streetName ? `${label} onto ${streetName}` : label;
}

function groupIntoSegments(edgesUsed) {
  const segments = [];
  for (let i = 0; i < edgesUsed.length; i++) {
    const edge = edgesUsed[i];
    const last = segments[segments.length - 1];
    if (last && last.streetName === edge.streetName) {
      last.endEdgeIdx = i;
      last.distance += edge.distance;
    } else {
      segments.push({ streetName: edge.streetName, startEdgeIdx: i, endEdgeIdx: i, distance: edge.distance });
    }
  }
  return segments;
}

function buildManeuvers(path, edgesUsed, nodes) {
  if (edgesUsed.length === 0) return [];

  const segments = groupIntoSegments(edgesUsed);
  const bearingOfEdge = (idx) => {
    const a = nodes.get(path[idx]);
    const b = nodes.get(path[idx + 1]);
    return bearingDegrees(a.lat, a.lon, b.lat, b.lon);
  };

  const maneuvers = [];
  const firstNode = nodes.get(path[0]);
  maneuvers.push({
    type: "depart",
    instruction: segments[0].streetName ? `Head out on ${segments[0].streetName}` : "Head out",
    streetName: segments[0].streetName,
    coordinate: [firstNode.lon, firstNode.lat],
    distanceMeters: Math.round(segments[0].distance),
  });

  for (let s = 1; s < segments.length; s++) {
    const prevSeg = segments[s - 1];
    const seg = segments[s];
    const bearingBefore = bearingOfEdge(prevSeg.endEdgeIdx);
    const bearingAfter = bearingOfEdge(seg.startEdgeIdx);
    const turn = classifyTurn(bearingBefore, bearingAfter);
    const node = nodes.get(path[seg.startEdgeIdx]);
    maneuvers.push({
      type: turn,
      instruction: maneuverInstruction(turn, seg.streetName),
      streetName: seg.streetName,
      coordinate: [node.lon, node.lat],
      distanceMeters: Math.round(seg.distance),
    });
  }

  const lastNode = nodes.get(path[path.length - 1]);
  maneuvers.push({
    type: "arrive",
    instruction: "Arrive at destination",
    streetName: null,
    coordinate: [lastNode.lon, lastNode.lat],
    distanceMeters: 0,
  });

  return maneuvers;
}

function summarize(result, nodes, extraSecondsPerLight) {
  if (!result) return null;
  const { path, edgesUsed } = result;

  let distance = 0;
  let timeSec = 0;
  const trafficLights = [];

  for (const edge of edgesUsed) {
    distance += edge.distance;
    timeSec += edge.timeSec;
    if (edge.isSignalEntry) {
      const node = nodes.get(edge.to);
      trafficLights.push({ lat: node.lat, lon: node.lon });
      timeSec += extraSecondsPerLight;
    }
  }

  const coordinates = path.map((id) => {
    const n = nodes.get(id);
    return [n.lon, n.lat];
  });

  return {
    coordinates,
    distanceMeters: Math.round(distance),
    estimatedTimeSec: Math.round(timeSec),
    trafficLightCount: trafficLights.length,
    trafficLights,
    maneuvers: buildManeuvers(path, edgesUsed, nodes),
  };
}

export function computeRoutes({ adjacency, nodes, restrictions }, startId, endId, options = {}) {
  const extraSecondsPerLight = options.extraSecondsPerLight ?? 15;
  const restrictionMap = restrictions ?? new Map();

  const fewestLights = dijkstra(
    adjacency,
    restrictionMap,
    startId,
    endId,
    (edge) => edge.distance + (edge.isSignalEntry ? LIGHT_PENALTY_METERS : 0)
  );

  const fastest = dijkstra(adjacency, restrictionMap, startId, endId, (edge) => edge.timeSec);

  const shortest = dijkstra(adjacency, restrictionMap, startId, endId, (edge) => edge.distance);

  return {
    fewestLights: summarize(fewestLights, nodes, extraSecondsPerLight),
    fastest: summarize(fastest, nodes, extraSecondsPerLight),
    shortest: summarize(shortest, nodes, extraSecondsPerLight),
  };
}
