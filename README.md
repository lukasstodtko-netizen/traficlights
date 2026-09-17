# SmoothRide

A route planner for scooter/motorcycle riders that finds the route with the **fewest traffic lights ahead of you** - instead of the shortest or fastest route. Background: if you can filter to the front at a red light, you barely lose time to congestion - the real time cost is the sheer number of light stops.

## Features

- Route calculation with three variants to compare: **fewest lights**, **fastest route**, **shortest route** - each with distance, estimated travel time, and light count.
- Traffic lights are marked on the map.
- Real address search (Nominatim) and a real street network including traffic lights (OpenStreetMap/Overpass API) - requires internet access.
- **Real map tiles**: when the browser has internet access to OpenStreetMap map services, the app shows a real map (MapLibre GL JS + OSM tiles) with zoom/pan, colored route lines, and clickable light/start/destination markers. Otherwise it automatically falls back to a schematic Canvas view (see below).
- Favorites (e.g. your daily commute), stored in the browser (localStorage).
- **Traffic rules**: turn restrictions from OpenStreetMap (`no_left_turn`, `only_straight_on`, …) are respected - the route never proposes a turn that's illegal there.
- **Real-time navigation**: turn-by-turn instructions with a live location dot (GPS), automatic progress tracking, automatic rerouting if you drift off the route, and the map zooms in once you start navigating.
- **Design in the style of Apple Maps**: a full-bleed map as the backdrop, a floating glass panel (blur effect) for search/favorites/route options - a card top-left on desktop, a bottom sheet with a drag handle on phones. The turn-by-turn instruction appears as a dark banner at the top (with a rotating turn arrow), distance/time at the bottom - plus automatic light/dark mode based on the system setting.
- Your current location is always shown on the map, not just while navigating.

## Architecture

Deliberately built **without build tools and without external npm packages**:

- `server/` - Node.js backend, using only Node built-ins (`node:http`, `fetch`, …), no `npm install` needed.
  - `overpass.js` - loads streets, traffic lights (`highway=traffic_signals`), and turn restrictions (`relation[type=restriction]`) from OpenStreetMap via the Overpass API.
  - `geocode.js` - address search via Nominatim.
  - `graph.js` - builds a directed graph from the OSM data (accounting for one-way streets), decides per intersection whether a traffic light is even relevant for a given direction of travel, and builds the turn-restriction lookup (see below).
  - `routing.js` - Dijkstra routing; the "fewest lights" variant weights every traffic-light node with a very high extra cost, so the light count is minimized first and distance only breaks ties (lexicographic optimization). Each Dijkstra step's state is (node, which street you arrived on) rather than just (node), so turn restrictions can be enforced correctly. Also generates turn-by-turn instructions (`maneuvers`) per route.
  - `sampleData.js` - a synthetic street network used exclusively as a fixture for the automated tests (`test/routing.test.js`), not part of the running app.
  - `index.js` - HTTP server: API endpoints + serving the frontend.
- `public/` - frontend as plain HTML/CSS/JavaScript (no frameworks, no build step; `app.js` runs as an ES module).
  - `app.js` contains two map renderers: a real map via **MapLibre GL JS** (loaded from a CDN, OSM raster tiles as the map background) and a Canvas view as a fallback. Also drives the real-time navigation (see below).
  - `nav-math.js` - pure, dependency-free geometry functions for navigation (projecting a position onto the route, computing progress/drift) - deliberately kept separate from the DOM/geolocation glue in `app.js` so it can be unit-tested with Node.

### Why two map renderers (MapLibre + Canvas fallback)?

`index.html` loads MapLibre GL JS via a `<script>` tag from a CDN (unpkg). If that fails (no internet access, a corporate/school proxy blocking the CDN or the map tiles, etc.), `app.js` detects it automatically (the `USE_MAPLIBRE` check) and draws the route schematically on a `<canvas>` instead - no real map imagery, but the same data and interactions. A small note on the map indicates which mode is active.

This two-path approach became necessary because the development sandbox this project was built in blocks all access to the npm registry, CDNs, and map services (Overpass, Nominatim, tile servers) via network policy - React/Vite/MapLibre couldn't be installed there, and even a CDN-loaded MapLibre couldn't fetch real tiles. The MapLibre code path was instead verified with a local mock implementation of `maplibregl` (map creation, route/light layers, `fitBounds` behavior, zoom-on-navigate, follow-while-navigating) - **on a machine with normal internet access, you should still double-check the real map view yourself** before relying on it.

Note on the map tiles: it uses `tile.openstreetmap.org` directly (no cost, no API key). For more than very occasional private use, the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) requires running your own tile server or using a supported provider (e.g. MapTiler, Stadia Maps) - for this prototype/commute tool, direct use is fine.

### Direction-aware light counting

The whole point of the app is to only count traffic lights that actually matter for your direction of travel. `graph.js` checks, per intersection node:

1. If OpenStreetMap tags the node with `traffic_signals:direction` (or, failing that, `direction`) as `forward`/`backward`, the light only counts for the matching direction of travel along the street (the opposite direction never sees this light at all).
2. If a compass bearing is tagged instead (e.g. `direction=70`), the actual approach bearing is computed and the light only counts if it roughly (±90°) matches the light's orientation.
3. If no direction is tagged at all (the most common case - an intersection with one shared light node for every approach), the light still counts for every direction passing through that node - correct for most simple intersections, since each approach there has its own light phase anyway.

This covers the cases where OSM actually maintains direction information (e.g. separate lights per direction at a junction, or a light that only controls one turn lane); where OSM has no direction tagged, it falls back to the previous, generally correct assumption of "one node = one light for every approach."

### Traffic rules: turn restrictions

The route respects turn restrictions from OpenStreetMap (`relation[type=restriction]`, e.g. `no_left_turn`, `no_u_turn`, `only_straight_on`). Technically: the Dijkstra state isn't just "at which node" but "at which node, having arrived via which street" - only that lets you check whether the next turn is forbidden specifically from that approach. Without this, the app could suggest routes that are shorter/have fewer lights but are actually illegal to drive.

Limitations: only the simple, most common shape is evaluated (`from` way → `via` **node** → `to` way). Restrictions via a `via` **way** (rare, complex multi-lane junctions) and vehicle-specific/conditional variants (`restriction:motorcycle`, `restriction:conditional`) are not evaluated - normal (unrestricted) edge logic applies there.

### Real-time navigation

After a route is calculated, tapping **"Go"** starts turn-by-turn guidance:

- A single persistent `navigator.geolocation.watchPosition()` call (started once when the app loads, browser permission required; works on `localhost` even without HTTPS, otherwise HTTPS is required) powers both the always-visible "you are here" dot and, once active, turn-by-turn navigation.
- Before any route exists, the first GPS fix centers the map on you once (afterwards the view is left alone so it doesn't fight you panning around); starting navigation zooms the map in close and keeps following your position at that zoom level.
- The current position is projected onto the route (`public/nav-math.js`), which derives: the currently relevant instruction, distance to the next turn, distance/time remaining.
- If the position drifts more than 40 m from the route, a new route from the current position to the original destination is calculated automatically (with a 12 s cooldown so it doesn't recalculate on every bit of GPS noise).
- Arrival detection checks the direct distance to the destination point (not the route projection) - otherwise a position far off the route could falsely register as "arrived" because the projection snaps to the end of the route (this is captured as a regression test in `nav-math.test.js`).
- Turn-by-turn instructions (`routing.js`, `maneuvers`) are derived from street-name changes along the route plus the computed turn bearing (slight/normal/sharp left or right) - like most simple route planners, not lane-level guidance.

## Running it

No `npm install` required (no external dependencies):

```bash
cd server
node src/index.js
```

Then open in a browser: <http://localhost:3001>

For automatic restarts on changes:

```bash
npm run dev -w server   # or: node --watch server/src/index.js
```

## Deployment (Netlify)

The app is also set up for Netlify:

- `public/` is served as a static site (`netlify.toml` → `publish = "public"`).
- The API routes run there as **Netlify Functions** (`netlify/functions/*.mts`) instead of a long-running process - each function imports the same logic from `server/src/api.js` that the local Node server also uses (`getGeocodeResults`, `getLiveRoute`). That keeps the local server and the Netlify deployment behaving identically without maintaining the code twice.
- The functions are mapped via `config.path` onto the exact same paths the frontend already calls (`/api/geocode`, `/api/route`, `/api/health`) - nothing had to change on the frontend for this.
- The root `package.json` includes `@netlify/functions` as a dev dependency for the functions' TypeScript types.

**Note on live routing on Netlify**: serverless functions have a time limit (usually 10 s). `netlify/functions/route.mts` therefore aborts the Overpass query after 9 s with a clean error instead of letting the platform hard-kill the function. For very long commutes (large bounding boxes), this could get tight.

### A project has already been created

Via the Netlify tools, the project **`smoothride-scooter`** was created (<https://app.netlify.com/projects/smoothride-scooter>, live URL: `https://smoothride-scooter.netlify.app`) and is linked to this GitHub repository's `claude/sharp-mayer-13byde` branch, so it deploys automatically on every push. (The names `smoothride` and `smoothride-app` were already taken on Netlify.)

Alternative, if you'd rather deploy via the CLI (from a machine with internet access):

```bash
npx -y netlify-cli deploy --prod --site df9ff3a5-eeb4-4a12-b797-570836b0b46e
```

## Tests

Plain Node core tests (no dependencies needed) cover graph construction, one-way street logic, light minimization, turn restrictions, turn-by-turn instructions, and the navigation progress calculation:

```bash
cd server
npm test
```

## Known limitations / possible next steps

- **Light direction logic**: evaluated via OSM's `traffic_signals:direction`/`direction` (see above). Where OSM has no direction tagged (the normal case for simple intersections), the light still counts for every direction of travel - generally correct, but could over-count in rare, untagged edge cases (e.g. a light that only controls a single turn lane).
- **Map rendering**: the real map renderer (MapLibre + OSM tiles) was only tested in this sandbox via a mock library, not with real map tiles (see above) - please double-check on your own machine.
- **Turn restrictions**: only `via`-node restrictions are evaluated, not `via`-way restrictions or vehicle-specific/conditional variants (see above).
- **Real-time navigation**: the whole navigation UI (live marker, progress, rerouting on drift, zoom-on-navigate) was only tested in this sandbox with mocked geolocation and mocked API responses via Playwright, not with real GPS/real Overpass data out on the road - please double-check on your scooter before relying on it blindly. No lane-level guidance (see above).
- **Bounding box size**: for very long commutes (>~30 km), the Overpass query may get large/slow; the area is currently capped.
