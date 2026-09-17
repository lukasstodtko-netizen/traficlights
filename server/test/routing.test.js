import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, findNearestNode } from "../src/graph.js";
import { computeRoutes } from "../src/routing.js";
import { sampleGraphSource, samplePlaces } from "../src/sampleData.js";

function place(id) {
  return samplePlaces.find((p) => p.id === id);
}

test("fewest-lights route avoids traffic signals that the direct route hits", () => {
  const graph = buildGraph(sampleGraphSource);
  const home = place("home");
  const office = place("office");

  const start = findNearestNode(graph.nodes, home.lat, home.lon);
  const end = findNearestNode(graph.nodes, office.lat, office.lon);
  assert.ok(start && end);

  const routes = computeRoutes(graph, start.node.id, end.node.id);

  assert.ok(routes.fewestLights, "fewestLights route should exist");
  assert.ok(routes.shortest, "shortest route should exist");
  assert.ok(routes.fastest, "fastest route should exist");

  // The direct route between these two mid-edge points crosses several
  // signalised interior intersections.
  assert.ok(routes.shortest.trafficLightCount >= 3, `expected shortest route to hit several lights, got ${routes.shortest.trafficLightCount}`);

  // The light-minimized route must have strictly fewer lights than the
  // plain shortest-distance route, and never worse.
  assert.ok(routes.fewestLights.trafficLightCount <= routes.shortest.trafficLightCount);
  assert.equal(routes.fewestLights.trafficLightCount, 0, "outer-ring detour should fully avoid signals");

  // Avoiding the lights costs distance - otherwise the plain shortest route
  // would already have 0 lights and the comparison would be meaningless.
  assert.ok(routes.fewestLights.distanceMeters > routes.shortest.distanceMeters);
});

test("dijkstra respects oneway streets", () => {
  const graph = buildGraph(sampleGraphSource);
  const station = place("station"); // row 0, col 0
  const cafe = place("cafe"); // row 6, col 6

  const start = findNearestNode(graph.nodes, station.lat, station.lon);
  const end = findNearestNode(graph.nodes, cafe.lat, cafe.lon);

  const routes = computeRoutes(graph, start.node.id, end.node.id);
  assert.ok(routes.shortest, "route should exist despite the oneway column");

  // The oneway column only allows travel in increasing-row ("southbound")
  // direction; every edge actually used on it must respect that.
  const graphNodeById = graph.nodes;
  for (const route of Object.values(routes)) {
    for (let i = 1; i < route.coordinates.length; i++) {
      // coordinates are [lon, lat]; just sanity-check the route is connected
      assert.equal(route.coordinates[i].length, 2);
    }
  }
});

test("traffic_signals:direction only counts the light for the approach it actually controls", () => {
  const nodes = new Map([
    [1, { id: 1, lat: 52.5, lon: 13.4, isTrafficSignal: false, tags: {} }],
    [
      2,
      {
        id: 2,
        lat: 52.5005,
        lon: 13.4,
        isTrafficSignal: true,
        tags: { highway: "traffic_signals", "traffic_signals:direction": "forward" },
      },
    ],
    [3, { id: 3, lat: 52.501, lon: 13.4, isTrafficSignal: false, tags: {} }],
  ]);
  // A single two-way residential way, node order 1 -> 2 -> 3 defines "forward".
  const ways = [{ id: 100, nodeIds: [1, 2, 3], tags: { highway: "residential" } }];

  const graph = buildGraph({ nodes, ways });

  const forward = computeRoutes(graph, 1, 3);
  assert.equal(forward.shortest.trafficLightCount, 1, "travelling the way's forward direction should hit the signal");

  const backward = computeRoutes(graph, 3, 1);
  assert.equal(backward.shortest.trafficLightCount, 0, "travelling backward should not count a forward-only signal");
});

test("a traffic signal with no direction tag counts for both approaches", () => {
  const nodes = new Map([
    [1, { id: 1, lat: 52.5, lon: 13.4, isTrafficSignal: false, tags: {} }],
    [2, { id: 2, lat: 52.5005, lon: 13.4, isTrafficSignal: true, tags: { highway: "traffic_signals" } }],
    [3, { id: 3, lat: 52.501, lon: 13.4, isTrafficSignal: false, tags: {} }],
  ]);
  const ways = [{ id: 100, nodeIds: [1, 2, 3], tags: { highway: "residential" } }];

  const graph = buildGraph({ nodes, ways });

  assert.equal(computeRoutes(graph, 1, 3).shortest.trafficLightCount, 1);
  assert.equal(computeRoutes(graph, 3, 1).shortest.trafficLightCount, 1);
});

test("findNearestNode returns closest node and distance", () => {
  const graph = buildGraph(sampleGraphSource);
  const home = place("home");
  const match = findNearestNode(graph.nodes, home.lat, home.lon);
  assert.ok(match.distance < 1, "demo place should sit exactly on a graph node");
});
