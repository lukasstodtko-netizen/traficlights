import type { Config } from "@netlify/functions";
import { getGeocodeResults } from "../../server/src/api.js";

export default async (req: Request) => {
  const url = new URL(req.url);
  try {
    const results = await getGeocodeResults(url.searchParams.get("q"));
    return Response.json({ results });
  } catch (err: any) {
    return Response.json({ error: err.message || "Interner Serverfehler" }, { status: err.statusCode || 500 });
  }
};

export const config: Config = {
  path: "/api/geocode",
};
