import type { Config } from "@netlify/functions";
import { getDemoPlacesList } from "../../server/src/api.js";

export default async () => {
  return Response.json({ places: getDemoPlacesList() });
};

export const config: Config = {
  path: "/api/demo/places",
};
