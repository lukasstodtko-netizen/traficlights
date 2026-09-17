const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

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
  const query = `
    [out:json][timeout:30];
    (
      way["highway"~"${highwayRegex}"]["motor_vehicle"!="no"]["access"!="private"](${bboxStr});
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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
    }
  }

  return { nodes, ways };
}
