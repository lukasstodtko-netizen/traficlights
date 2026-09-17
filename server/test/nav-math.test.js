import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineMeters,
  projectOntoRoute,
  maneuverDistancesAlongRoute,
  computeProgress,
} from "../../public/nav-math.js";

// A simple straight route heading east along lat 52.5, roughly 100m per coordinate step.
const STEP_LON = 0.0014; // ~100m at this latitude
const ROUTE_COORDS = [
  [13.4, 52.5],
  [13.4 + STEP_LON, 52.5],
  [13.4 + STEP_LON * 2, 52.5],
  [13.4 + STEP_LON * 3, 52.5],
];
const ROUTE = {
  coordinates: ROUTE_COORDS,
  distanceMeters: Math.round(
    haversineMeters(52.5, 13.4, 52.5, 13.4 + STEP_LON) +
      haversineMeters(52.5, 13.4 + STEP_LON, 52.5, 13.4 + STEP_LON * 2) +
      haversineMeters(52.5, 13.4 + STEP_LON * 2, 52.5, 13.4 + STEP_LON * 3)
  ),
};
const MANEUVERS = [
  { instruction: "Losfahren", coordinate: ROUTE_COORDS[0] },
  { instruction: "Rechts abbiegen", coordinate: ROUTE_COORDS[2] },
  { instruction: "Ziel erreicht", coordinate: ROUTE_COORDS[3] },
];

test("projectOntoRoute finds the closest point and distance-along-route", () => {
  // A point right on the second coordinate, slightly off to the side.
  const proj = projectOntoRoute(52.5001, 13.4 + STEP_LON, ROUTE_COORDS);
  assert.ok(proj.distanceMeters < 20, "should snap close to the route");
  assert.ok(
    Math.abs(proj.distanceAlongRouteMeters - haversineMeters(52.5, 13.4, 52.5, 13.4 + STEP_LON)) < 5,
    "distance along route should match the first segment's length"
  );
});

test("computeProgress advances through maneuvers as the position moves along the route", () => {
  const maneuverDistances = maneuverDistancesAlongRoute(ROUTE_COORDS, MANEUVERS);

  const atStart = computeProgress(52.5, 13.4, ROUTE, maneuverDistances);
  assert.equal(atStart.activeManeuverIndex, 1, "should be heading toward the 'turn right' maneuver, not 'depart'");
  assert.equal(atStart.isOffRoute, false);

  const nearTurn = computeProgress(52.5, 13.4 + STEP_LON * 2 - 0.00005, ROUTE, maneuverDistances);
  assert.equal(nearTurn.activeManeuverIndex, 2, "close to the turn, the next active maneuver should be 'arrive'");

  const atEnd = computeProgress(52.5, 13.4 + STEP_LON * 3, ROUTE, maneuverDistances);
  assert.ok(atEnd.hasArrived, "at the final coordinate, navigation should report arrival");
});

test("computeProgress flags a position far from the route as off-route", () => {
  const maneuverDistances = maneuverDistancesAlongRoute(ROUTE_COORDS, MANEUVERS);
  const farAway = computeProgress(52.51, 13.5, ROUTE, maneuverDistances);
  assert.equal(farAway.isOffRoute, true);
});

test("a position far beyond the route's last segment is off-route, not falsely 'arrived'", () => {
  // Regression test: projecting onto the last segment clamps to its endpoint,
  // which used to make distanceRemainingMeters look like ~0 (and therefore
  // "arrived") even though the real GPS fix is over a kilometer away.
  const maneuverDistances = maneuverDistancesAlongRoute(ROUTE_COORDS, MANEUVERS);
  const wayOff = computeProgress(52.51, 13.4 + STEP_LON * 2 + 0.01, ROUTE, maneuverDistances);
  assert.equal(wayOff.isOffRoute, true);
  assert.equal(wayOff.hasArrived, false);
});

test("computeProgress stays on-route for a position with only minor GPS noise", () => {
  const maneuverDistances = maneuverDistancesAlongRoute(ROUTE_COORDS, MANEUVERS);
  const slightlyOff = computeProgress(52.50005, 13.4 + STEP_LON, ROUTE, maneuverDistances);
  assert.equal(slightlyOff.isOffRoute, false);
});
