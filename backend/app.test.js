const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { app, resetState } = require("./app");
const {
  haversineKm,
  inventoryIsFresh,
  validCoordinate,
} = require("./postgres-api");
const {
  fetchLocations,
  normalizeElement,
  overpassQuery,
} = require("./scripts/import-osm-stores");
const { buildDemoNetwork, syntheticSource } = require("./demo-bengaluru-network");

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => resetState());

test("nearby stock rescue reports same-SKU candidates and missing proximity constraints", async () => {
  const response = await fetch(
    `${baseUrl}/api/stock-rescue?storeId=7&sku=D001&radiusKm=10`
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.target.currentStock, 14);
  assert.equal(result.target.expectedShortageBeforeTruck, 13);
  assert.equal(result.proximityVerified, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].storeId, 9);
  assert.equal(result.candidates[0].stock, 60);
  assert.equal(result.candidates[0].distanceKm, null);
  assert.equal(result.candidates[0].safeTransferableSurplus, null);
  assert.equal(result.candidates[0].feasible, false);
  assert.ok(result.candidates[0].constraints.some((constraint) =>
    constraint.includes("safety-stock")
  ));
});

test("Bengaluru synthetic seed is 30 clearly labelled records with a deterministic rescue example", () => {
  const records = buildDemoNetwork();
  assert.equal(records.length, 30);
  assert.equal(new Set(records.map(({ store }) => store.locality)).size, 15);
  assert.ok(records.every(({ store, inventory }) =>
    store.verificationStatus === "simulated" &&
    store.locationSource === syntheticSource &&
    inventory.inventorySource === syntheticSource
  ));
  const destination = records.find(({ store }) => store.storeId === 1001);
  const donor = records.find(({ store }) => store.storeId === 1002);
  assert.equal(destination.inventory.stock, 4);
  assert.equal(destination.inventory.hourlyDemand, 8);
  assert.equal(donor.inventory.stock, 50);
  assert.equal(donor.inventory.safetyStock, 8);
});

test("JSON demo seed is additive, idempotent, and preserves pending action statuses", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { seedJsonDemoNetwork } = require("./seed-demo-json");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zipcart-state-"));
  const statePath = path.join(directory, "data.json");
  const initialState = {
    inventory: [{ storeId: 7, sku: "ORIGINAL", stock: 4 }],
    deliveries: [],
    actions: [{ id: "pending-1", status: "PENDING" }],
    nextActionId: 2,
  };
  fs.writeFileSync(statePath, JSON.stringify(initialState), "utf8");
  try {
    assert.deepEqual(seedJsonDemoNetwork(statePath), {
      storesAdded: 30,
      inventoryAdded: 30,
    });
    assert.deepEqual(seedJsonDemoNetwork(statePath), {
      storesAdded: 0,
      inventoryAdded: 0,
    });
    const seeded = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(seeded.inventory.length, 31);
    assert.deepEqual(seeded.inventory[0], initialState.inventory[0]);
    assert.deepEqual(seeded.actions, initialState.actions);
    assert.equal(seeded.inventory[1].verificationStatus, "simulated");
    assert.equal(seeded.stores[0].latitude, 12.9698);
    assert.ok(seeded.stores[0].locationSource.includes("illustrative"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("store creation and editing validate areas, coordinates, and duplicate IDs", async () => {
  const record = {
    storeId: 77,
    name: "Zipcart Test Hub",
    locality: "Whitefield",
    address: "Operator-entered demo address",
    city: "Bengaluru",
    state: "Karnataka",
  };
  const created = await fetch(`${baseUrl}/api/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).verificationStatus, "simulated");

  const duplicate = await fetch(`${baseUrl}/api/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  assert.equal(duplicate.status, 409);

  const invalidArea = await fetch(`${baseUrl}/api/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...record, storeId: 78, locality: "Not a configured area" }),
  });
  assert.equal(invalidArea.status, 400);

  const invalidCoordinates = await fetch(`${baseUrl}/api/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...record, storeId: 79, latitude: 12.9, longitude: 77.6 }),
  });
  assert.equal(invalidCoordinates.status, 400);

  const edited = await fetch(`${baseUrl}/api/stores/77`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...record, name: "Zipcart Updated Hub", active: false }),
  });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).name, "Zipcart Updated Hub");
  const stores = await (await fetch(`${baseUrl}/api/stores`)).json();
  assert.ok(!stores.stores.some((store) => store.storeId === 77));
});

test("a simulated rescue proposal records approval without moving stock until completion", async () => {
  const [destination, donor] = buildDemoNetwork();
  const addInventory = async ({ store, inventory: item }) => {
    const response = await fetch(`${baseUrl}/api/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId: item.storeId,
        storeName: store.name,
        locality: store.locality,
        city: store.city,
        state: store.state,
        latitude: store.latitude,
        longitude: store.longitude,
        locationSource: store.locationSource,
        sku: item.sku,
        product: item.product,
        stock: item.stock,
        hourlyDemand: item.hourlyDemand,
        safetyStock: item.safetyStock,
        shelfCapacity: item.shelfCapacity,
        truckArrivalHour: item.truckArrivalHour,
        transferEtaHours: item.transferEtaHours,
        transportCapacity: item.transportCapacity,
      }),
    });
    assert.equal(response.status, 201);
  };
  await addInventory(destination);
  await addInventory(donor);

  const rescue = await (
    await fetch(`${baseUrl}/api/stock-rescue?storeId=1001&sku=D001&radiusKm=10`)
  ).json();
  assert.equal(rescue.target.stockoutInHours, 0.5);
  assert.equal(rescue.target.expectedShortageBeforeTruck, 20);
  assert.equal(rescue.candidates[0].storeId, 1002);
  assert.ok(rescue.candidates[0].distanceKm < 1);
  assert.equal(rescue.candidates[0].safeTransferableSurplus, 30);
  assert.equal(rescue.candidates[0].estimatedTransferQuantity, 20);
  assert.equal(rescue.candidates[0].feasible, true);

  const proposalResponse = await fetch(`${baseUrl}/api/transfers/proposals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId: 1001,
      donorStoreId: 1002,
      sku: "D001",
      scenario: "baseline",
    }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = await proposalResponse.json();
  assert.equal(proposal.action.quantity, 20);
  assert.match(proposal.message, /no inventory was moved/i);

  const approval = await fetch(`${baseUrl}/api/actions/${proposal.action.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "APPROVED" }),
  });
  assert.equal(approval.status, 200);
  let inventory = await (await fetch(`${baseUrl}/api/inventory`)).json();
  assert.equal(inventory.find((item) => item.storeId === 1001).stock, 4);
  assert.equal(inventory.find((item) => item.storeId === 1002).stock, 50);

  const completion = await fetch(
    `${baseUrl}/api/actions/${proposal.action.id}/complete`,
    { method: "POST" }
  );
  assert.equal(completion.status, 200);
  inventory = await (await fetch(`${baseUrl}/api/inventory`)).json();
  assert.equal(inventory.find((item) => item.storeId === 1001).stock, 24);
  assert.equal(inventory.find((item) => item.storeId === 1002).stock, 30);
  const history = await (
    await fetch(`${baseUrl}/api/actions/${proposal.action.id}/history`)
  ).json();
  assert.deepEqual(history.map((entry) => entry.toStatus), [
    "PENDING",
    "APPROVED",
    "COMPLETED",
  ]);
});

test("rejecting a feasible proposed transfer leaves both stocks unchanged", async () => {
  for (const { store, inventory: item } of buildDemoNetwork().slice(0, 2)) {
    const response = await fetch(`${baseUrl}/api/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId: item.storeId,
        storeName: store.name,
        locality: store.locality,
        latitude: store.latitude,
        longitude: store.longitude,
        locationSource: store.locationSource,
        sku: item.sku,
        product: item.product,
        stock: item.stock,
        hourlyDemand: item.hourlyDemand,
        safetyStock: item.safetyStock,
        shelfCapacity: item.shelfCapacity,
        truckArrivalHour: item.truckArrivalHour,
        transferEtaHours: item.transferEtaHours,
        transportCapacity: item.transportCapacity,
      }),
    });
    assert.equal(response.status, 201);
  }
  const before = await (await fetch(`${baseUrl}/api/inventory`)).json();
  const proposal = await fetch(`${baseUrl}/api/transfers/proposals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId: 1001, donorStoreId: 1002, sku: "D001" }),
  });
  const { action } = await proposal.json();
  const rejected = await fetch(`${baseUrl}/api/actions/${action.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "REJECTED" }),
  });
  assert.equal(rejected.status, 200);
  const after = await (await fetch(`${baseUrl}/api/inventory`)).json();
  assert.equal(after.find((item) => item.storeId === 1001).stock, before.find((item) => item.storeId === 1001).stock);
  assert.equal(after.find((item) => item.storeId === 1002).stock, before.find((item) => item.storeId === 1002).stock);
});

test("health and inventory endpoints return the current backend records", async () => {
  const health = await fetch(`${baseUrl}/`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "OK");

  const response = await fetch(`${baseUrl}/api/inventory`);
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.equal(inventory.length, 3);
  assert.equal(inventory[0].sku, "D001");
});

test("hourly baseline forecast floors stock at zero and reports unmet demand", async () => {
  const response = await fetch(
    `${baseUrl}/api/forecast/7/D001?hours=4&scenario=baseline`
  );
  assert.equal(response.status, 200);
  const forecast = await response.json();
  assert.equal(forecast.forecast[0].forecastDemand, 9);
  assert.equal(forecast.forecast[0].projectedStock, 5);
  assert.equal(forecast.forecast[1].projectedStock, 0);
  assert.equal(forecast.forecast[1].estimatedUnfilledDemand, 4);
  assert.ok(forecast.forecast.every((hour) => hour.projectedStock >= 0));
  assert.equal(forecast.expectedShortageBeforeTruck, 13);
});

test("event uplift uses baseline times one plus uplift and only affects matching hours/categories", async () => {
  const drinkResponse = await fetch(
    `${baseUrl}/api/forecast/7/D001?hours=4&scenario=cricket&eventStartHour=2`
  );
  const drink = await drinkResponse.json();
  assert.equal(drink.forecast[0].forecastDemand, 9);
  assert.equal(drink.forecast[1].forecastDemand, 27);
  assert.equal(drink.forecast[3].forecastDemand, 9);
  assert.equal(drink.forecast[1].upliftPercent, 200);
  assert.equal(drink.forecast[1].estimatedUnfilledDemand, 22);

  const chipsResponse = await fetch(
    `${baseUrl}/api/forecast/7/S001?hours=2&scenario=cricket&eventStartHour=2`
  );
  const chips = await chipsResponse.json();
  assert.equal(chips.forecast[1].forecastDemand, 3);
});

test("an unverified transfer cannot be approved and rejection leaves stock unchanged", async () => {
  const recommendationResponse = await fetch(
    `${baseUrl}/api/recommendations/7/D001?scenario=baseline`
  );
  const result = await recommendationResponse.json();
  assert.equal(result.recommendation.action, "REVIEW");
  assert.equal(result.recommendation.feasible, false);
  assert.ok(
    result.recommendation.constraints.some((constraint) =>
      constraint.includes("safety-stock")
    )
  );

  const beforeInventory = await (await fetch(`${baseUrl}/api/inventory`)).json();
  const approveResponse = await fetch(
    `${baseUrl}/api/actions/${result.recommendation.id}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "APPROVED" }),
    }
  );
  assert.equal(approveResponse.status, 409);
  const afterFailedApproval = await (await fetch(`${baseUrl}/api/inventory`)).json();
  assert.deepEqual(afterFailedApproval, beforeInventory);

  const rejectResponse = await fetch(
    `${baseUrl}/api/actions/${result.recommendation.id}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "REJECTED" }),
    }
  );
  assert.equal(rejectResponse.status, 200);
  const afterRejection = await (await fetch(`${baseUrl}/api/inventory`)).json();
  assert.deepEqual(afterRejection, beforeInventory);
});

test("a transfer with explicit safety, timing, capacity, and shelf data is revalidated and applied", async () => {
  const donorResponse = await fetch(`${baseUrl}/api/inventory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId: 11,
      sku: "D001",
      product: "Cold Drink 750ml",
      stock: 50,
      hourlyDemand: 1,
      shelfCapacity: 70,
      truckArrivalHour: 5,
      safetyStock: 4,
      transferEtaHours: 0.5,
      transportCapacity: 10,
      latitude: 12.9736,
      longitude: 77.5986,
      locationSource: "test fixture coordinates",
    }),
  });
  assert.equal(donorResponse.status, 201);

  const destinationLocationResponse = await fetch(`${baseUrl}/api/stores/7`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test destination",
      locality: "Whitefield",
      city: "Bengaluru",
      state: "Karnataka",
      latitude: 12.9698,
      longitude: 77.75,
      locationSource: "test fixture coordinates",
    }),
  });
  assert.equal(destinationLocationResponse.status, 200);

  const recommendationResponse = await fetch(
    `${baseUrl}/api/recommendations/7/D001?scenario=baseline`
  );
  const recommendation = await recommendationResponse.json();
  assert.equal(recommendation.recommendation.action, "TRANSFER");
  assert.equal(recommendation.recommendation.feasible, true);
  assert.equal(recommendation.recommendation.quantity, 6);

  const approvalResponse = await fetch(
    `${baseUrl}/api/actions/${recommendation.recommendation.id}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "APPROVED" }),
    }
  );
  assert.equal(approvalResponse.status, 200);
  let inventory = await (await fetch(`${baseUrl}/api/inventory`)).json();
  assert.equal(
    inventory.find((item) => item.storeId === 7).stock,
    14,
    "approval records the plan without moving inventory"
  );
  assert.equal(
    inventory.find((item) => item.storeId === 11).stock,
    50
  );
  assert.equal((await approvalResponse.json()).action.status, "APPROVED");

  const completionResponse = await fetch(
    `${baseUrl}/api/actions/${recommendation.recommendation.id}/complete`,
    { method: "POST" }
  );
  assert.equal(completionResponse.status, 200);
  inventory = await (await fetch(`${baseUrl}/api/inventory`)).json();
  assert.equal(inventory.find((item) => item.storeId === 7).stock, 20);
  assert.equal(inventory.find((item) => item.storeId === 11).stock, 44);
  const history = await (
    await fetch(`${baseUrl}/api/actions/${recommendation.recommendation.id}/history`)
  ).json();
  assert.deepEqual(history.map((entry) => entry.toStatus), [
    "PENDING",
    "APPROVED",
    "COMPLETED",
  ]);

  const duplicateResponse = await fetch(
    `${baseUrl}/api/actions/${recommendation.recommendation.id}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "APPROVED" }),
    }
  );
  assert.equal(duplicateResponse.status, 409);
});

test("CORS allows the configured frontend origin without allowing arbitrary origins", async () => {
  const allowed = await fetch(`${baseUrl}/api/inventory`, {
    headers: { Origin: "http://localhost:3001" },
  });
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "http://localhost:3001"
  );

  const denied = await fetch(`${baseUrl}/api/inventory`, {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("geographic validation and nearby distance use bounded coordinates and haversine", () => {
  assert.equal(validCoordinate(12.9716, 77.5946), true);
  assert.equal(validCoordinate(91, 77.5946), false);
  assert.equal(validCoordinate(12.9716, -181), false);
  const distance = haversineKm(12.9716, 77.5946, 12.9352, 77.6245);
  assert.ok(distance > 4 && distance < 6, `unexpected Bengaluru distance: ${distance}`);
  assert.equal(haversineKm(12.9716, 77.5946, 12.9716, 77.5946), 0);
  const now = Date.now();
  assert.equal(inventoryIsFresh(new Date(now - 23 * 3600000).toISOString(), now), true);
  assert.equal(inventoryIsFresh(new Date(now - 25 * 3600000).toISOString(), now), false);
  assert.equal(inventoryIsFresh(null, now), false);
});

test("OSM import normalizes actual element coordinates and never invents missing ones", () => {
  const node = normalizeElement({
    type: "node",
    id: 123,
    lat: 12.9716,
    lon: 77.5946,
    tags: {
      name: "Example Market",
      shop: "supermarket",
      "addr:suburb": "Central",
    },
  });
  assert.equal(node.sourceId, "osm-node-123");
  assert.equal(node.name, "Example Market");
  assert.equal(node.latitude, 12.9716);
  assert.equal(node.longitude, 77.5946);
  assert.equal(node.locality, "Central");
  assert.equal(normalizeElement({ type: "way", id: 9, tags: { name: "No coordinates" } }), null);
  assert.match(overpassQuery(), /12\.834,77\.46,13\.139,77\.784/);
});

test("OSM importer deduplicates source IDs and checks provider errors", async () => {
  const payload = {
    elements: [
      { type: "node", id: 1, lat: 12.9, lon: 77.5, tags: { name: "Market", shop: "supermarket" } },
      { type: "node", id: 1, lat: 12.9, lon: 77.5, tags: { name: "Market", shop: "supermarket" } },
      { type: "node", id: 2, lat: 12.9, lon: 77.5, tags: { shop: "convenience" } },
    ],
  };
  const imported = await fetchLocations(async () => ({
    ok: true,
    json: async () => payload,
  }));
  assert.equal(imported.length, 1);
  await assert.rejects(
    fetchLocations(async () => ({ ok: false, status: 429 })),
    /HTTP 429/
  );
});

test("JSON mode labels simulated stores and never fabricates coordinates or stock", async () => {
  const response = await fetch(`${baseUrl}/api/stores`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.stores.length, 2);
  assert.ok(payload.stores.every((store) => store.latitude === null && store.longitude === null));
  assert.ok(payload.stores.every((store) => store.verificationStatus === "simulated"));

  const nearby = await fetch(
    `${baseUrl}/api/stores/nearby?latitude=12.9716&longitude=77.5946&radiusKm=5`
  );
  assert.equal(nearby.status, 200);
  assert.deepEqual((await nearby.json()).stores, []);
  const invalid = await fetch(
    `${baseUrl}/api/stores/nearby?latitude=91&longitude=77.5946`
  );
  assert.equal(invalid.status, 400);
});

test("action comparison returns four explicit options and deterministic reasoning", async () => {
  const response = await fetch(
    `${baseUrl}/api/action-comparison/7/D001?scenario=baseline`
  );
  assert.equal(response.status, 200);
  const comparison = await response.json();
  assert.equal(comparison.options.length, 4);
  assert.deepEqual(
    comparison.options.map((option) => option.type),
    ["TRANSFER", "EARLIER_TRUCK", "SHELF_SWAP", "WAIT"]
  );
  assert.ok(comparison.options.every((option) => typeof option.expectedShortage === "number"));
  assert.ok(comparison.reasoning.some((step) => step.step === "Validate safety stock, shelf capacity and logistics"));
  assert.equal(comparison.preferredOption, null);
});

test("inventory updates validate capacity and preserve the JSON state flow", async () => {
  const update = await fetch(`${baseUrl}/api/inventory/7/D001`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stock: 12, hourlyDemand: 8, shelfCapacity: 20, safetyStock: 3 }),
  });
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.stock, 12);
  assert.equal(updated.hourlyDemand, 8);
  assert.equal(updated.safetyStock, 3);
  const invalid = await fetch(`${baseUrl}/api/inventory/7/D001`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stock: 12, hourlyDemand: 8, shelfCapacity: 11 }),
  });
  assert.equal(invalid.status, 400);
});

test("simulated delivery plans can be scheduled and read back", async () => {
  const initial = await fetch(`${baseUrl}/api/deliveries`);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), []);

  const scheduled = await fetch(`${baseUrl}/api/deliveries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId: 7, sku: "D001", hour: 2, quantity: 4 }),
  });
  assert.equal(scheduled.status, 201);

  const deliveries = await (await fetch(`${baseUrl}/api/deliveries`)).json();
  assert.deepEqual(deliveries, [
    {
      storeId: 7,
      sku: "D001",
      arrivalHour: 2,
      quantity: 4,
      dataSource: "JSON demo persistence",
    },
  ]);
});
