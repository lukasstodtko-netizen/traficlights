import type { Config } from "@netlify/functions";

export default async () => {
  return Response.json({ ok: true });
};

export const config: Config = {
  path: "/api/health",
};
