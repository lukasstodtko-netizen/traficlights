import { test } from "node:test";
import assert from "node:assert/strict";
import { simplifyAddress } from "../src/geocode.js";

test("simplifyAddress turns a street address into 'Street Number' + city", () => {
  const nominatimResult = {
    display_name: "1, Musterstraße, Mitte, Berlin, 10115, Deutschland",
    address: {
      house_number: "1",
      road: "Musterstraße",
      suburb: "Mitte",
      city: "Berlin",
      postcode: "10115",
      country: "Deutschland",
    },
  };
  const { primary, secondary, label } = simplifyAddress(nominatimResult);
  assert.equal(primary, "Musterstraße 1");
  assert.equal(secondary, "Berlin");
  assert.equal(label, "Musterstraße 1, Berlin");
});

test("simplifyAddress puts a named place (POI) first, with the street as context", () => {
  const nominatimResult = {
    display_name: "Alexanderplatz, Mitte, Berlin, 10178, Deutschland",
    address: {
      amenity: "Alexanderplatz",
      road: "Alexanderplatz",
      city: "Berlin",
      postcode: "10178",
    },
  };
  const { primary, secondary } = simplifyAddress(nominatimResult);
  assert.equal(primary, "Alexanderplatz");
  assert.ok(secondary.includes("Berlin"));
});

test("simplifyAddress falls back to postcode when no city is available", () => {
  const nominatimResult = {
    display_name: "Musterweg, 12345, Deutschland",
    address: { road: "Musterweg", postcode: "12345" },
  };
  const { primary, secondary } = simplifyAddress(nominatimResult);
  assert.equal(primary, "Musterweg");
  assert.equal(secondary, "12345");
});

test("simplifyAddress falls back to the first display_name segment when address details are sparse", () => {
  const nominatimResult = {
    display_name: "Somewhere Remote, Nowhere County",
    address: {},
  };
  const { primary, label } = simplifyAddress(nominatimResult);
  assert.equal(primary, "Somewhere Remote");
  assert.equal(typeof label, "string");
  assert.ok(label.length > 0);
});
