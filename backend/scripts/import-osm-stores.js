const db = require("../db");

const OVERPASS_URL =
  process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const BENGALURU_BOUNDS = {
  south: 12.834,
  west: 77.46,
  north: 13.139,
  east: 77.784,
};

function overpassQuery() {
  const { south, west, north, east } = BENGALURU_BOUNDS;
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:45];
(
  node["shop"~"supermarket|convenience|greengrocer|department_store"](${box});
  way["shop"~"supermarket|convenience|greengrocer|department_store"](${box});
  relation["shop"~"supermarket|convenience|greengrocer|department_store"](${box});
);
out center tags;`;
}

function normalizeElement(element) {
  const tags = element.tags || {};
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  const name = tags.name || tags["name:en"] || tags.brand;
  if (!name) return null;
  const address = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
  ]
    .filter(Boolean)
    .join(", ");
  return {
    sourceId: `osm-${element.type}-${element.id}`,
    name: String(name).trim(),
    address: address || tags["addr:full"] || null,
    locality: tags["addr:suburb"] || tags["addr:neighbourhood"] || null,
    city: tags["addr:city"] || "Bengaluru",
    state: tags["addr:state"] || "Karnataka",
    postalCode: tags["addr:postcode"] || null,
    latitude,
    longitude,
    storeType: tags.shop,
  };
}

async function fetchLocations(fetchImpl = fetch) {
  const response = await fetchImpl(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ZipcartAI-HackathonDemo/1.0 (OSM public retail location import)",
    },
    body: new URLSearchParams({ data: overpassQuery() }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`Overpass API returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.elements)) {
    throw new Error("Overpass response did not contain an elements list.");
  }
  const seen = new Set();
  return payload.elements
    .map(normalizeElement)
    .filter((location) => {
      if (!location || seen.has(location.sourceId)) return false;
      seen.add(location.sourceId);
      return true;
    });
}

async function importLocations(locations, database = db) {
  if (!database.enabled) throw new Error("DATABASE_URL is required to import OSM locations.");
  return database.transaction(async (client) => {
    let imported = 0;
    for (const store of locations) {
      await client.query(
        `INSERT INTO stores (
           name, address, locality, city, state, postal_code, latitude, longitude,
           geographic_source_id, location_source, geography_retrieved_at,
           store_type, verification_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OpenStreetMap',NOW(),$10,'unverified')
         ON CONFLICT (geographic_source_id) DO UPDATE SET
           name = EXCLUDED.name, address = EXCLUDED.address, locality = EXCLUDED.locality,
           city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code,
           latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
           location_source = EXCLUDED.location_source,
           geography_retrieved_at = NOW(), store_type = EXCLUDED.store_type, updated_at = NOW()
         RETURNING store_id`,
        [
          store.name,
          store.address,
          store.locality,
          store.city,
          store.state,
          store.postalCode,
          store.latitude,
          store.longitude,
          store.sourceId,
          store.storeType,
        ]
      );
      imported += 1;
    }
    return imported;
  });
}

async function run() {
  const stores = await fetchLocations();
  const imported = await importLocations(stores);
  console.log(
    `Imported or refreshed ${imported} Bengaluru retail locations from OpenStreetMap. ` +
      "Locations are unverified as Zipcart stores and have no implied inventory. © OpenStreetMap contributors."
  );
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error("OSM store import failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = {
  BENGALURU_BOUNDS,
  fetchLocations,
  importLocations,
  normalizeElement,
  overpassQuery,
};
