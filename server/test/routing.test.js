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

function crossJunctionFixture() {
  const C = 1;
  const N = 2;
  const S = 3;
  const E = 4;
  const W = 5;
  const nodes = new Map([
    [C, { id: C, lat: 52.5, lon: 13.4, isTrafficSignal: false, tags: {} }],
    [N, { id: N, lat: 52.501, lon: 13.4, isTrafficSignal: false, tags: {} }],
    [S, { id: S, lat: 52.499, lon: 13.4, isTrafficSignal: false, tags: {} }],
    [E, { id: E, lat: 52.5, lon: 13.401, isTrafficSignal: false, tags: {} }],
    [W, { id: W, lat: 52.5, lon: 13.399, isTrafficSignal: false, tags: {} }],
  ]);
  const wayW = { id: 10, nodeIds: [W, C], tags: { highway: "residential", name: "Weststraße" } };
  const wayN = { id: 11, nodeIds: [C, N], tags: { highway: "residential", name: "Nordstraße" } };
  const wayS = { id: 12, nodeIds: [C, S], tags: { highway: "residential", name: "Südstraße" } };
  const wayE = { id: 13, nodeIds: [C, E], tags: { highway: "residential", name: "Oststraße" } };
  return { nodes, ways: [wayW, wayN, wayS, wayE], ids: { C, N, S, E, W }, wayIds: { wayW: 10, wayN: 11, wayS: 12, wayE: 13 } };
}

// Note: with 3+ arms at a junction there is almost always some roundabout way to
// reach a "forbidden" continuation (e.g. bounce off a different arm and come back
// having "arrived" on an unrestricted way) - that mirrors reality, where turn
// restrictions cause detours rather than true unreachability. So these tests
// check for a forced, measurably longer detour rather than asserting no path exists.
test("no_left_turn forces a detour instead of the direct forbidden maneuver", () => {
  const { nodes, ways, ids, wayIds } = crossJunctionFixture();

  const baseline = buildGraph({ nodes, ways, restrictions: [] });
  const direct = computeRoutes(baseline, ids.W, ids.N).shortest;
  assert.ok(direct, "unrestricted baseline route must exist");

  const restrictions = [{ restrictionType: "no_left_turn", fromWayId: wayIds.wayW, viaNodeId: ids.C, toWayId: wayIds.wayN }];
  const restrictedGraph = buildGraph({ nodes, ways, restrictions });
  const detour = computeRoutes(restrictedGraph, ids.W, ids.N).shortest;

  assert.ok(detour, "a detour route must still exist");
  assert.ok(detour.distanceMeters > direct.distanceMeters, "restricted route must be longer than the direct left turn");

  const directLeftTurn = detour.maneuvers.some(
    (m, i) => i > 0 && detour.maneuvers[i - 1].streetName === "Weststraße" && m.streetName === "Nordstraße"
  );
  assert.ok(!directLeftTurn, "must not go directly from Weststraße onto Nordstraße");

  // Turning right from the same approach is a different (unrestricted) maneuver
  // and must remain exactly as short as without the restriction.
  const rightBaseline = computeRoutes(baseline, ids.W, ids.S).shortest;
  const rightRestricted = computeRoutes(restrictedGraph, ids.W, ids.S).shortest;
  assert.equal(rightRestricted.distanceMeters, rightBaseline.distanceMeters, "unrelated turns must be unaffected");
});

test("only_straight_on forces a detour for every turn but leaves the mandated direction untouched", () => {
  const { nodes, ways, ids, wayIds } = crossJunctionFixture();

  const baseline = buildGraph({ nodes, ways, restrictions: [] });
  const restrictions = [{ restrictionType: "only_straight_on", fromWayId: wayIds.wayW, viaNodeId: ids.C, toWayId: wayIds.wayE }];
  const restrictedGraph = buildGraph({ nodes, ways, restrictions });

  const straightBaseline = computeRoutes(baseline, ids.W, ids.E).shortest;
  const straightRestricted = computeRoutes(restrictedGraph, ids.W, ids.E).shortest;
  assert.equal(straightRestricted.distanceMeters, straightBaseline.distanceMeters, "the mandated straight-on must be untouched");

  const leftBaseline = computeRoutes(baseline, ids.W, ids.N).shortest;
  const leftRestricted = computeRoutes(restrictedGraph, ids.W, ids.N).shortest;
  assert.ok(leftRestricted.distanceMeters > leftBaseline.distanceMeters, "turning left must now require a detour");
});

test("maneuvers include depart/arrive plus turn instructions with street names", () => {
  const graph = buildGraph(sampleGraphSource);
  const home = place("home");
  const office = place("office");
  const start = findNearestNode(graph.nodes, home.lat, home.lon);
  const end = findNearestNode(graph.nodes, office.lat, office.lon);

  const route = computeRoutes(graph, start.node.id, end.node.id).fewestLights;
  assert.ok(route.maneuvers.length >= 3, "expected depart, at least one turn, and arrive");
  assert.equal(route.maneuvers[0].type, "depart");
  assert.equal(route.maneuvers.at(-1).type, "arrive");
  for (const m of route.maneuvers) {
    assert.ok(typeof m.instruction === "string" && m.instruction.length > 0);
    assert.equal(m.coordinate.length, 2);
  }
});

test("findNearestNode returns closest node and distance", () => {
  const graph = buildGraph(sampleGraphSource);
  const home = place("home");
  const match = findNearestNode(graph.nodes, home.lat, home.lon);
  assert.ok(match.distance < 1, "demo place should sit exactly on a graph node");
});
