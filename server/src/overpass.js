const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Some infrastructure in front of overpass-api.de rejects requests with no/generic
// User-Agent (e.g. the default "node" from a serverless runtime) with a bare Apache
// 406, before the request ever reaches the Overpass application. A descriptive
// User-Agent avoids that - same reasoning as for the Nominatim client in geocode.js.
const USER_AGENT = "TrafiLights/1.0 (route planner prototype)";

// Road types a scooter/motorcycle can legally use. Footways, cycleways,
// pedestrian-only paths etc. are intentionally excluded.
const DRIVABLE_HIGHWAYS = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
];

export async function fetchRoadNetwork(bbox) {
  const highwayRegex = `^(${DRIVABLE_HIGHWAYS.join("|")})$`;
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  // Also fetch turn-restriction relations (no_left_turn, only_straight_on, ...) so
  // the router doesn't suggest turns that are actually illegal.
  const query = `
    [out:json][timeout:30];
    (
      way["highway"~"${highwayRegex}"]["motor_vehicle"!="no"]["access"!="private"](${bboxStr});
      relation["type"="restriction"](${bboxStr});
    );
    out body;
    >;
    out body qt;
  `.trim();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28000);

  let response;
  try {
    response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Overpass-Anfrage fehlgeschlagen (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await response.json();

  const nodes = new Map();
  const ways = [];
  const restrictions = [];

  for (const el of data.elements) {
    if (el.type === "node") {
      nodes.set(el.id, {
        id: el.id,
        lat: el.lat,
        lon: el.lon,
        isTrafficSignal: el.tags?.highway === "traffic_signals",
        tags: el.tags || {},
      });
    } else if (el.type === "way") {
      ways.push({
        id: el.id,
        nodeIds: el.nodes,
        tags: el.tags || {},
      });
    } else if (el.type === "relation" && el.tags?.type === "restriction") {
      // Only the common "via a single node" shape is handled - a via *way*
      // (used for a few complex multi-lane junctions) is rare and skipped.
      const restrictionType = el.tags.restriction;
      const fromWay = el.members?.find((m) => m.role === "from" && m.type === "way");
      const viaNode = el.members?.find((m) => m.role === "via" && m.type === "node");
      const toWay = el.members?.find((m) => m.role === "to" && m.type === "way");
      if (restrictionType && fromWay && viaNode && toWay) {
        restrictions.push({
          restrictionType,
          fromWayId: fromWay.ref,
          viaNodeId: viaNode.ref,
          toWayId: toWay.ref,
        });
      }
    }
  }

  return { nodes, ways, restrictions };
}
