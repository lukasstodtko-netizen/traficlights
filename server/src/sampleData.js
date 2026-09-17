// Small synthetic "Musterstadt" street grid used as a fixture for the automated
// tests (test/routing.test.js). It has the same shape as data returned by
// overpass.js (nodes/ways with OSM-style tags), so it flows through the exact
// same buildGraph()/computeRoutes() code as real OpenStreetMap data - without
// needing network access to verify routing/graph logic.
//
// Layout: 7x7 intersections (rows 0-6, columns 0-6). All intersections in the
// interior (row 1-5 AND column 1-5) have traffic signals; the outer ring does not.
// This means a straight line between two mid-edge points crosses several lights,
// while a route hugging the light-free outer ring avoids them at the cost of
// extra distance - a good showcase for the app's whole point.

const BASE_LAT = 52.5;
const BASE_LON = 13.4;
const GRID_SIZE = 7;
const SPACING_M = 130;

function metersToLat(m) {
  return m / 111320;
}
function metersToLon(m, atLat) {
  return m / (111320 * Math.cos((atLat * Math.PI) / 180));
}

function build() {
  const nodes = new Map();
  const grid = [];
  let nodeId = 1;

  for (let r = 0; r < GRID_SIZE; r++) {
    grid[r] = [];
    for (let c = 0; c < GRID_SIZE; c++) {
      const lat = BASE_LAT + metersToLat(r * SPACING_M);
      const lon = BASE_LON + metersToLon(c * SPACING_M, BASE_LAT);
      const isSignal = r >= 1 && r <= 5 && c >= 1 && c <= 5;
      const id = nodeId++;
      nodes.set(id, {
        id,
        lat,
        lon,
        isTrafficSignal: isSignal,
        tags: isSignal ? { highway: "traffic_signals" } : {},
      });
      grid[r][c] = id;
    }
  }

  const ways = [];
  let wayId = 1;

  for (let r = 0; r < GRID_SIZE; r++) {
    ways.push({ id: wayId++, nodeIds: grid[r], tags: { highway: "residential", name: `Musterstraße ${r + 1}` } });
  }
  for (let c = 0; c < GRID_SIZE; c++) {
    const nodeIds = grid.map((row) => row[c]);
    const tags =
      c === 6
        ? { highway: "tertiary", name: "Ostallee (Einbahnstraße)", oneway: "yes" }
        : { highway: "residential", name: `Ringweg ${c + 1}` };
    ways.push({ id: wayId++, nodeIds, tags });
  }

  return { nodes, ways, grid };
}

const { nodes, ways, grid } = build();

export const sampleGraphSource = { nodes, ways };

const rawPlaces = [
  { id: "home", name: "Zuhause (Demo)", row: 3, col: 0 },
  { id: "office", name: "Büro (Demo)", row: 3, col: 6 },
  { id: "station", name: "Bahnhof (Demo)", row: 0, col: 0 },
  { id: "cafe", name: "Lieblingscafé (Demo)", row: 6, col: 6 },
];

export const samplePlaces = rawPlaces.map((p) => {
  const node = nodes.get(grid[p.row][p.col]);
  return { id: p.id, name: p.name, lat: node.lat, lon: node.lon };
});
