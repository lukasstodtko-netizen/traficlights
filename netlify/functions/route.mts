import type { Config } from "@netlify/functions";
import { getLiveRoute } from "../../server/src/api.js";

// Netlify's synchronous functions have a hard execution time limit (10s on most plans).
// Overpass can occasionally be slow for large bounding boxes, so we fail fast with a
// clean error well before the platform would kill the function outright.
const FUNCTION_TIMEOUT_MS = 9000;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error("Zeitüberschreitung bei den Kartendaten (Overpass)"), { statusCode: 504 })), ms)
  );
}

export default async (req: Request) => {
  const url = new URL(req.url);
  try {
    const result = await Promise.race([
      getLiveRoute({
        fromLat: parseFloat(url.searchParams.get("fromLat") || ""),
        fromLon: parseFloat(url.searchParams.get("fromLon") || ""),
        toLat: parseFloat(url.searchParams.get("toLat") || ""),
        toLon: parseFloat(url.searchParams.get("toLon") || ""),
      }),
      timeout(FUNCTION_TIMEOUT_MS),
    ]);
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ error: err.message || "Interner Serverfehler" }, { status: err.statusCode || 500 });
  }
};

export const config: Config = {
  path: "/api/route",
};
