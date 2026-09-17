// Shared API logic used by both the plain Node server (server/src/index.js, for local
// zero-dependency development) and the Netlify Functions (netlify/functions/*.mts, for
// deployment). Keeping it here means both entry points behave identically and there is
// only one place to fix bugs or change behavior.

import { fetchRoadNetwork } from "./overpass.js";
import { buildGraph, findNearestNode } from "./graph.js";
import { computeRoutes } from "./routing.js";
import { geocode } from "./geocode.js";
import { boundingBox } from "./geo.js";
import { getDemoPlaces, computeDemoRoute } from "./demo.js";

function apiError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export async function getGeocodeResults(rawQuery) {
  const q = (rawQuery || "").trim();
  if (q.length < 3) {
    throw apiError(400, "Query-Parameter 'q' (min. 3 Zeichen) erforderlich");
  }
  try {
    return await geocode(q);
  } catch (err) {
    throw apiError(502, `Geocoding fehlgeschlagen: ${err.message || err}`);
  }
}

// Cache the built graph per bbox for a while so repeated route requests in the same
// area (e.g. slightly adjusting the destination) don't re-hit Overpass every time.
// On Netlify this only helps within a single warm function instance - that's fine,
// it's a nice-to-have, not something correctness depends on.
const graphCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function bboxKey(bbox) {
  const round = (v) => Math.round(v * 200) / 200; // ~0.005 deg grid
  return [round(bbox.south), round(bbox.west), round(bbox.north), round(bbox.east)].join(",");
}

async function getGraphForBbox(bbox) {
  const key = bboxKey(bbox);
  const cached = graphCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.graph;
  }
  const raw = await fetchRoadNetwork(bbox);
  const graph = buildGraph(raw);
  graphCache.set(key, { graph, timestamp: Date.now() });
  return graph;
}

export async function getLiveRoute({ fromLat, fromLon, toLat, toLon }) {
  if ([fromLat, fromLon, toLat, toLon].some((v) => Number.isNaN(v))) {
    throw apiError(400, "fromLat, fromLon, toLat, toLon sind erforderlich");
  }

  let graph;
  try {
    const bbox = boundingBox(fromLat, fromLon, toLat, toLon);
    graph = await getGraphForBbox(bbox);
  } catch (err) {
    throw apiError(502, `Routenberechnung fehlgeschlagen: ${err.message || err}`);
  }

  const startMatch = findNearestNode(graph.nodes, fromLat, fromLon);
  const endMatch = findNearestNode(graph.nodes, toLat, toLon);

  if (!startMatch || !endMatch) {
    throw apiError(422, "Kein Straßennetz in der Nähe der angegebenen Punkte gefunden");
  }
  if (startMatch.distance > 500 || endMatch.distance > 500) {
    throw apiError(422, "Start- oder Zielpunkt liegt zu weit vom bekannten Straßennetz entfernt");
  }

  const routes = computeRoutes(graph, startMatch.node.id, endMatch.node.id);
  if (!routes.fewestLights) {
    throw apiError(422, "Keine Route zwischen den Punkten gefunden");
  }

  return {
    start: { lat: startMatch.node.lat, lon: startMatch.node.lon },
    end: { lat: endMatch.node.lat, lon: endMatch.node.lon },
    routes,
  };
}

export function getDemoPlacesList() {
  return getDemoPlaces();
}

export function getDemoRoute(fromId, toId) {
  if (!fromId || !toId) {
    throw apiError(400, "fromId und toId sind erforderlich");
  }
  return computeDemoRoute(fromId, toId);
}
