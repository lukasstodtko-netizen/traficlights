import type { Config } from "@netlify/functions";
import { getDemoRoute } from "../../server/src/api.js";

export default async (req: Request) => {
  const url = new URL(req.url);
  try {
    const result = getDemoRoute(url.searchParams.get("fromId"), url.searchParams.get("toId"));
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ error: err.message || "Interner Serverfehler" }, { status: err.statusCode || 500 });
  }
};

export const config: Config = {
  path: "/api/demo/route",
};
