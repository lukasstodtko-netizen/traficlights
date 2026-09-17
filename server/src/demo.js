import { buildGraph, findNearestNode } from "./graph.js";
import { computeRoutes } from "./routing.js";
import { sampleGraphSource, samplePlaces } from "./sampleData.js";

// Built once and reused - the demo graph is tiny and never changes.
const demoGraph = buildGraph(sampleGraphSource);

export function getDemoPlaces() {
  return samplePlaces;
}

export function computeDemoRoute(fromId, toId) {
  const from = samplePlaces.find((p) => p.id === fromId);
  const to = samplePlaces.find((p) => p.id === toId);
  if (!from || !to) {
    throw Object.assign(new Error("Unbekannter Demo-Ort"), { statusCode: 400 });
  }

  const start = findNearestNode(demoGraph.nodes, from.lat, from.lon);
  const end = findNearestNode(demoGraph.nodes, to.lat, to.lon);
  const routes = computeRoutes(demoGraph, start.node.id, end.node.id);

  return {
    start: { lat: start.node.lat, lon: start.node.lon },
    end: { lat: end.node.lat, lon: end.node.lon },
    routes,
  };
}
