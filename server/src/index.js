import { createServer } from "node:http";
import { getGeocodeResults, getLiveRoute, getDemoPlacesList, getDemoRoute } from "./api.js";
import { serveStatic } from "./staticServer.js";

const PORT = process.env.PORT || 3001;

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendApiError(res, err) {
  console.error("API error:", err);
  sendJson(res, err.statusCode || 500, { error: err.message || "Interner Serverfehler" });
}

async function handleGeocode(query, res) {
  try {
    const results = await getGeocodeResults(query.get("q"));
    sendJson(res, 200, { results });
  } catch (err) {
    sendApiError(res, err);
  }
}

async function handleRoute(query, res) {
  try {
    const result = await getLiveRoute({
      fromLat: parseFloat(query.get("fromLat")),
      fromLon: parseFloat(query.get("fromLon")),
      toLat: parseFloat(query.get("toLat")),
      toLon: parseFloat(query.get("toLon")),
    });
    sendJson(res, 200, result);
  } catch (err) {
    sendApiError(res, err);
  }
}

function handleDemoPlaces(res) {
  sendJson(res, 200, { places: getDemoPlacesList() });
}

function handleDemoRoute(query, res) {
  try {
    const result = getDemoRoute(query.get("fromId"), query.get("toId"));
    sendJson(res, 200, result);
  } catch (err) {
    sendApiError(res, err);
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
