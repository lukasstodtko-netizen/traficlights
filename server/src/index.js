import { createServer } from "node:http";
import { fetchRoadNetwork } from "./overpass.js";
import { buildGraph, findNearestNode } from "./graph.js";
import { computeRoutes } from "./routing.js";
import { geocode } from "./geocode.js";
import { boundingBox } from "./geo.js";
import { getDemoPlaces, computeDemoRoute } from "./demo.js";
import { serveStatic } from "./staticServer.js";

const PORT = process.env.PORT || 3001;

// Cache the built graph per bbox for a while so repeated route requests
// in the same area (e.g. slightly adjusting the destination) don't
// re-hit Overpass every time.
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

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function handleGeocode(query, res) {
  const q = query.get("q");
  if (!q || q.trim().length < 3) {
    return sendJson(res, 400, { error: "Query-Parameter 'q' (min. 3 Zeichen) erforderlich" });
  }
  try {
    const results = await geocode(q.trim());
    sendJson(res, 200, { results });
  } catch (err) {
    console.error("Geocode error:", err);
    sendJson(res, 502, { error: "Geocoding fehlgeschlagen", detail: String(err.message || err) });
  }
}

async function handleRoute(query, res) {
  const fromLat = parseFloat(query.get("fromLat"));
  const fromLon = parseFloat(query.get("fromLon"));
  const toLat = parseFloat(query.get("toLat"));
  const toLon = parseFloat(query.get("toLon"));

  if ([fromLat, fromLon, toLat, toLon].some((v) => Number.isNaN(v))) {
    return sendJson(res, 400, { error: "fromLat, fromLon, toLat, toLon sind erforderlich" });
  }

  try {
    const bbox = boundingBox(fromLat, fromLon, toLat, toLon);
    const graph = await getGraphForBbox(bbox);

    const startMatch = findNearestNode(graph.nodes, fromLat, fromLon);
    const endMatch = findNearestNode(graph.nodes, toLat, toLon);

    if (!startMatch || !endMatch) {
      return sendJson(res, 422, { error: "Kein Straßennetz in der Nähe der angegebenen Punkte gefunden" });
    }
    if (startMatch.distance > 500 || endMatch.distance > 500) {
      return sendJson(res, 422, {
        error: "Start- oder Zielpunkt liegt zu weit vom bekannten Straßennetz entfernt",
      });
    }

    const routes = computeRoutes(graph, startMatch.node.id, endMatch.node.id);
    if (!routes.fewestLights) {
      return sendJson(res, 422, { error: "Keine Route zwischen den Punkten gefunden" });
    }

    sendJson(res, 200, {
      start: { lat: startMatch.node.lat, lon: startMatch.node.lon },
      end: { lat: endMatch.node.lat, lon: endMatch.node.lon },
      routes,
    });
  } catch (err) {
    console.error("Route error:", err);
    sendJson(res, 502, { error: "Routenberechnung fehlgeschlagen", detail: String(err.message || err) });
  }
}

function handleDemoPlaces(res) {
  sendJson(res, 200, { places: getDemoPlaces() });
}

function handleDemoRoute(query, res) {
  const fromId = query.get("fromId");
  const toId = query.get("toId");
  if (!fromId || !toId) {
    return sendJson(res, 400, { error: "fromId und toId sind erforderlich" });
  }
  try {
    const result = computeDemoRoute(fromId, toId);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: err.message });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname, searchParams } = url;

    if (pathname === "/api/health") return sendJson(res, 200, { ok: true });
    if (pathname === "/api/geocode") return await handleGeocode(searchParams, res);
    if (pathname === "/api/route") return await handleRoute(searchParams, res);
    if (pathname === "/api/demo/places") return handleDemoPlaces(res);
    if (pathname === "/api/demo/route") return handleDemoRoute(searchParams, res);

    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "Unbekannter Endpunkt" });
    }

    const served = await serveStatic(req, res, pathname);
    if (!served) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  } catch (err) {
    console.error("Unhandled error:", err);
    sendJson(res, 500, { error: "Interner Serverfehler" });
  }
});

server.listen(PORT, () => {
  console.log(`TrafiLights server listening on http://localhost:${PORT}`);
});
