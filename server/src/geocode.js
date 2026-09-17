const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Nominatim's usage policy requires a descriptive User-Agent identifying the app.
const USER_AGENT = "SmoothRide/1.0 (route planner prototype)";

// Nominatim's raw display_name is a long, comma-separated administrative chain
// (e.g. "1, Musterstraße, Mitte, Berlin, 10115, Deutschland"). That's overwhelming
// in a mobile-width autocomplete list, so we reduce every result to a short
// "primary" line (the thing itself: a named place, or street + house number)
// and a short "secondary" line (just enough context to disambiguate: city or
// postcode) - the same two-line shape most map apps use for address search.
export function simplifyAddress(result) {
  const a = result.address || {};
  const poiName = result.namedetails?.name || a.amenity || a.shop || a.tourism || a.leisure || a.building || null;
  const road = a.road || a.pedestrian || a.footway || a.cycleway || null;
  const houseNumber = a.house_number || null;
  const streetLine = road ? [road, houseNumber].filter(Boolean).join(" ") : null;
  const city = a.city || a.town || a.village || a.municipality || a.county || null;

  const primary = poiName || streetLine || result.display_name.split(",")[0].trim();

  const secondaryParts = [];
  if (poiName && streetLine) secondaryParts.push(streetLine);
  if (city) secondaryParts.push(city);
  else if (a.postcode) secondaryParts.push(a.postcode);
  if (secondaryParts.length === 0 && a.country) secondaryParts.push(a.country);
  const secondary = secondaryParts.join(", ");

  return {
    primary,
    secondary,
    label: secondary ? `${primary}, ${secondary}` : primary,
  };
}

export async function geocode(query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Geocoding failed (${response.status})`);
  }

  const results = await response.json();
  return results.map((r) => {
    const { primary, secondary, label } = simplifyAddress(r);
    return {
      displayName: label,
      primary,
      secondary,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    };
  });
}
