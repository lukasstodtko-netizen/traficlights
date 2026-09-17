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

/**
 * Generic Dijkstra over the adjacency graph.
 * costFn(edge) -> number, must be >= 0.
 * Returns { path: nodeId[], edgesUsed: Edge[] } or null if unreachable.
 */
function dijkstra(adjacency, startId, endId, costFn) {
  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const visited = new Set();
  const heap = new MinHeap();
  heap.push({ id: startId, priority: 0 });

  while (heap.size > 0) {
    const { id: u, priority: d } = heap.pop();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === endId) break;

    const edges = adjacency.get(u);
    if (!edges) continue;

    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      const newDist = d + costFn(edge);
      if (newDist < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, newDist);
        prev.set(edge.to, { from: u, edge });
        heap.push({ id: edge.to, priority: newDist });
      }
    }
  }

  if (!dist.has(endId)) return null;

  const path = [endId];
  const edgesUsed = [];
  let cur = endId;
  while (cur !== startId) {
    const step = prev.get(cur);
    if (!step) return null;
    edgesUsed.unshift(step.edge);
    path.unshift(step.from);
    cur = step.from;
  }

  return { path, edgesUsed };
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
  };
}

export function computeRoutes({ adjacency, nodes }, startId, endId, options = {}) {
  const extraSecondsPerLight = options.extraSecondsPerLight ?? 15;

  const fewestLights = dijkstra(
    adjacency,
    startId,
    endId,
    (edge) => edge.distance + (edge.isSignalEntry ? LIGHT_PENALTY_METERS : 0)
  );

  const fastest = dijkstra(adjacency, startId, endId, (edge) => edge.timeSec);

  const shortest = dijkstra(adjacency, startId, endId, (edge) => edge.distance);

  return {
    fewestLights: summarize(fewestLights, nodes, extraSecondsPerLight),
    fastest: summarize(fastest, nodes, extraSecondsPerLight),
    shortest: summarize(shortest, nodes, extraSecondsPerLight),
  };
}
