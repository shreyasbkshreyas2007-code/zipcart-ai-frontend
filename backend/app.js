const express = require("express");
const cors = require("cors");
const fs = require("node:fs");
const path = require("node:path");
const database = require("./db");
const {
  handle: handleDatabaseRequest,
  haversineKm,
  validCoordinate,
} = require("./postgres-api");
const { areas: bengaluruAreas } = require("./demo-bengaluru-network");

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGINS || "http://localhost:3001")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
  })
);
app.use(express.json({ limit: "32kb" }));

app.use(async (req, res, next) => {
  try {
    const handled = await handleDatabaseRequest(req, res, scenarioConfig);
    if (!handled) next();
  } catch (error) {
    next(error);
  }
});

const initialInventory = [
  {
    storeId: 7,
    sku: "D001",
    product: "Cold Drink 750ml",
    stock: 14,
    hourlyDemand: 9,
    shelfCapacity: 20,
    truckArrivalHour: 3,
  },
  {
    storeId: 9,
    sku: "D001",
    product: "Cold Drink 750ml",
    stock: 60,
    hourlyDemand: 3,
    shelfCapacity: 80,
    truckArrivalHour: 4,
  },
  {
    storeId: 7,
    sku: "S001",
    product: "Potato Chips",
    stock: 10,
    hourlyDemand: 1,
    shelfCapacity: 12,
    truckArrivalHour: 3,
  },
];

const statePath = path.join(__dirname, "data.json");

const scenarioConfig = {
  cricket: {
    label: "Cricket match",
    upliftPercent: 200,
    categories: ["beverages", "snacks"],
    durationHours: 2,
    defaultStartHour: 1,
    source: "illustrative configured scenario",
  },
  festival: {
    label: "Festival",
    upliftPercent: 20,
    categories: ["sweets", "snacks", "produce"],
    durationHours: 4,
    defaultStartHour: 1,
    source: "illustrative scenario assumption",
  },
  rain: {
    label: "Rain",
    upliftPercent: 15,
    categories: ["essentials", "beverages"],
    durationHours: 3,
    defaultStartHour: 1,
    source: "illustrative scenario assumption",
  },
};

function readRuntimeState() {
  if (!fs.existsSync(statePath)) {
    return {
      inventory: initialInventory.map((item) => ({ ...item })),
      stores: [],
      deliveries: [],
      actions: [],
      actionHistory: [],
      nextActionId: 1,
    };
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (
    !state ||
    !Array.isArray(state.inventory) ||
    (state.stores !== undefined && !Array.isArray(state.stores)) ||
    !Array.isArray(state.deliveries) ||
    !Array.isArray(state.actions) ||
    (state.actionHistory !== undefined && !Array.isArray(state.actionHistory)) ||
    !Number.isInteger(state.nextActionId)
  ) {
    throw new Error(`Backend state file is invalid: ${statePath}`);
  }
  return state;
}

const runtimeState = readRuntimeState();
let inventory = runtimeState.inventory;
let storeRecords = runtimeState.stores || [];
let deliveries = runtimeState.deliveries;
let actions = runtimeState.actions;
let actionHistory = runtimeState.actionHistory || [];
let nextActionId = Math.max(
  runtimeState.nextActionId,
  ...actions.map((action) => Number(action.id) + 1).filter(Number.isFinite)
);

function persistRuntimeState() {
  if (require.main !== module) return;
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify({ inventory, stores: storeRecords, deliveries, actions, actionHistory, nextActionId }, null, 2),
    "utf8"
  );
  fs.renameSync(temporaryPath, statePath);
}

function storeLocation(item) {
  const store = storeRecords.find((record) => record.storeId === item.storeId);
  return {
    latitude: item.latitude ?? store?.latitude ?? null,
    longitude: item.longitude ?? store?.longitude ?? null,
  };
}

function resetState() {
  inventory = initialInventory.map((item) => ({ ...item }));
  storeRecords = [];
  deliveries = [];
  actions = [];
  actionHistory = [];
  nextActionId = 1;
}

function recordActionHistory(action, fromStatus, toStatus, details = {}) {
  actionHistory.push({
    actionId: action.id,
    fromStatus,
    toStatus,
    details,
    occurredAt: new Date().toISOString(),
  });
}

function findInventory(storeId, sku) {
  return inventory.find(
    (item) => item.storeId === Number(storeId) && item.sku === sku
  );
}

function inferCategory(product) {
  const name = product.toLowerCase();
  if (/drink|cola|soda|water|juice|tea|coffee/.test(name)) return "beverages";
  if (/snack|crisp|chip|biscuit|cookie|nuts/.test(name)) return "snacks";
  if (/sweet|cake|chocolate|dessert/.test(name)) return "sweets";
  if (/fruit|vegetable|produce/.test(name)) return "produce";
  if (/soap|clean|tissue|essential|umbrella/.test(name)) return "essentials";
  return "other";
}

function getScenario(query) {
  const requested = query.scenario;
  if (requested === undefined) {
    return {
      key: "cricket",
      config: scenarioConfig.cricket,
      startHour: scenarioConfig.cricket.defaultStartHour,
    };
  }
  if (requested === "baseline") {
    return { key: "baseline", config: null, startHour: 1 };
  }
  const config = scenarioConfig[requested];
  if (!config) {
    return { error: "Scenario must be baseline, cricket, festival, or rain." };
  }
  const startHour =
    query.eventStartHour === undefined
      ? config.defaultStartHour
      : Number(query.eventStartHour);
  if (!Number.isInteger(startHour) || startHour < 1 || startHour > 24) {
    return { error: "eventStartHour must be an integer from 1 to 24." };
  }
  return { key: requested, config, startHour };
}

function demandForHour(item, hour, scenario) {
  if (!scenario.config) return item.hourlyDemand;
  const endHour = scenario.startHour + scenario.config.durationHours - 1;
  const eventApplies =
    hour >= scenario.startHour &&
    hour <= endHour &&
    scenario.config.categories.includes(inferCategory(item.product));
  return (
    item.hourlyDemand *
    (eventApplies ? 1 + scenario.config.upliftPercent / 100 : 1)
  );
}

function deliveryForHour(item, hour) {
  return deliveries
    .filter(
      (delivery) =>
        delivery.storeId === item.storeId &&
        delivery.sku === item.sku &&
        delivery.hour === hour
    )
    .reduce((total, delivery) => total + delivery.quantity, 0);
}

function demandUntil(item, endHour, scenario) {
  const fullHours = Math.floor(endHour);
  let total = 0;
  for (let hour = 1; hour <= fullHours; hour += 1) {
    total += demandForHour(item, hour, scenario);
  }
  const fraction = endHour - fullHours;
  if (fraction > 0) {
    total += demandForHour(item, fullHours + 1, scenario) * fraction;
  }
  return total;
}

function deliveriesUntil(item, endHour) {
  return deliveries
    .filter(
      (delivery) =>
        delivery.storeId === item.storeId &&
        delivery.sku === item.sku &&
        delivery.hour <= Math.floor(endHour)
    )
    .reduce((sum, delivery) => sum + delivery.quantity, 0);
}

function buildForecast(item, hours = 4, scenario = getScenario({ scenario: "baseline" })) {
  let stock = item.stock;
  let stockoutInHours = null;
  const forecast = [];

  for (let hour = 1; hour <= hours; hour += 1) {
    const forecastDemand = demandForHour(item, hour, scenario);
    const scheduledDelivery = deliveryForHour(item, hour);
    const availableBeforeDemand = stock + scheduledDelivery;
    const unitsSold = Math.min(availableBeforeDemand, forecastDemand);
    const estimatedUnfilledDemand = forecastDemand - unitsSold;

    if (
      stockoutInHours === null &&
      forecastDemand > 0 &&
      availableBeforeDemand <= forecastDemand
    ) {
      stockoutInHours =
        hour - 1 + Math.min(1, availableBeforeDemand / forecastDemand);
    }

    stock = Math.max(0, availableBeforeDemand - unitsSold);
    forecast.push({
      hour,
      event: scenario.config
        ? hour >= scenario.startHour &&
          hour < scenario.startHour + scenario.config.durationHours &&
          scenario.config.categories.includes(inferCategory(item.product))
          ? scenario.config.label
          : "Baseline"
        : "Baseline",
      baselineDemand: item.hourlyDemand,
      upliftPercent:
        scenario.config &&
        hour >= scenario.startHour &&
        hour < scenario.startHour + scenario.config.durationHours &&
        scenario.config.categories.includes(inferCategory(item.product))
          ? scenario.config.upliftPercent
          : 0,
      forecastDemand,
      scheduledDelivery,
      projectedStock: stock,
      stockoutRisk: stockoutInHours !== null && stockoutInHours <= hour,
      estimatedUnfilledDemand,
    });
  }

  const truckArrivalHour = Math.max(0, item.truckArrivalHour);
  const demandBeforeTruck = demandUntil(item, truckArrivalHour, scenario);
  const deliveriesBeforeTruck = deliveries
    .filter(
      (delivery) =>
        delivery.storeId === item.storeId &&
        delivery.sku === item.sku &&
        delivery.hour < truckArrivalHour
    )
    .reduce((sum, delivery) => sum + delivery.quantity, 0);
  const expectedShortageBeforeTruck = Math.max(
    0,
    demandBeforeTruck - item.stock - deliveriesBeforeTruck
  );

  return {
    storeId: item.storeId,
    sku: item.sku,
    product: item.product,
    currentStock: item.stock,
    truckArrivalHour,
    scenario: {
      name: scenario.key,
      label: scenario.config?.label || "Baseline",
      upliftPercent: scenario.config?.upliftPercent || 0,
      appliesToCategories: scenario.config?.categories || [],
      startHour: scenario.config ? scenario.startHour : null,
      endHour: scenario.config
        ? scenario.startHour + scenario.config.durationHours - 1
        : null,
      dataQuality: scenario.config
        ? scenario.config.source
        : "baseline hourly demand input",
    },
    stockoutInHours,
    expectedShortageBeforeTruck,
    demandBeforeTruck,
    forecast,
  };
}

function transferAssessment(target, scenario, selectedDonorId = null) {
  const targetForecast = buildForecast(target, 24, scenario);
  const requiredQuantity = Math.ceil(targetForecast.expectedShortageBeforeTruck);
  const donors = inventory
    .filter(
      (item) =>
        item.storeId !== target.storeId &&
        item.sku === target.sku &&
        (selectedDonorId === null || item.storeId === Number(selectedDonorId))
    )
    .sort((left, right) => {
      const knownData = (item) =>
        Number(item.safetyStock !== undefined) +
        Number(item.transferEtaHours !== undefined) +
        Number(item.transportCapacity !== undefined);
      return knownData(right) - knownData(left);
    });
  const donor = donors[0];
  const constraints = [];
  if (!donor) {
    constraints.push("No other store with this SKU is in inventory.");
    return {
      feasible: false,
      donor: null,
      quantity: 0,
      requiredQuantity,
      targetForecast,
      constraints,
    };
  }

  if (donor.safetyStock === undefined) {
    constraints.push("Donor safety-stock threshold is not configured.");
  }
  if (donor.transferEtaHours === undefined) {
    constraints.push("Transfer delivery time is not configured.");
  }
  if (donor.transportCapacity === undefined) {
    constraints.push("Available transport capacity is not configured.");
  }
  const targetLocation = storeLocation(target);
  const donorLocation = storeLocation(donor);
  const coordinatesAvailable =
    targetLocation.latitude != null &&
    targetLocation.longitude != null &&
    donorLocation.latitude != null &&
    donorLocation.longitude != null &&
    validCoordinate(Number(targetLocation.latitude), Number(targetLocation.longitude)) &&
    validCoordinate(Number(donorLocation.latitude), Number(donorLocation.longitude));
  if (!coordinatesAvailable) {
    constraints.push("Destination or donor coordinates are unavailable; proximity cannot be verified.");
  }

  const destinationShelfSpace =
    target.shelfCapacity === undefined
      ? undefined
      : Math.max(0, target.shelfCapacity - target.stock);
  if (destinationShelfSpace === undefined) {
    constraints.push("Destination shelf capacity is not available.");
  }

  const donorDemandUntilReplenishment = demandUntil(
    donor,
    donor.truckArrivalHour,
    scenario
  );
  const donorInboundUntilReplenishment = deliveriesUntil(
    donor,
    donor.truckArrivalHour
  );
  const donorFloor =
    donor.safetyStock === undefined ||
    !Number.isFinite(donorDemandUntilReplenishment) ||
    !Number.isFinite(donorInboundUntilReplenishment)
      ? undefined
      : donor.safetyStock +
        donorDemandUntilReplenishment -
        donorInboundUntilReplenishment;
  const safeDonorSurplus =
    donorFloor === undefined
      ? undefined
      : Math.max(0, Math.floor(donor.stock - donorFloor));
  const donorAvailableAtTransfer =
    donor.transferEtaHours === undefined
      ? undefined
      : Math.max(
          0,
          donor.stock -
            demandUntil(donor, donor.transferEtaHours, scenario)
        );
  const donorSurplus =
    safeDonorSurplus === undefined || donorAvailableAtTransfer === undefined
      ? undefined
      : Math.min(safeDonorSurplus, Math.floor(donorAvailableAtTransfer));

  if (
    donor.transferEtaHours !== undefined &&
    targetForecast.stockoutInHours !== null &&
    donor.transferEtaHours >= targetForecast.stockoutInHours
  ) {
    constraints.push("Transfer ETA is not earlier than the predicted stockout.");
  }
  if (donorSurplus !== undefined && donorSurplus <= 0) {
    constraints.push(
      "Donor has no transferable stock after its safety stock and demand through its next replenishment."
    );
  }

  const knownLimits = [
    requiredQuantity,
    donorSurplus,
    destinationShelfSpace,
    donor.transportCapacity,
  ];
  const allConstraintsKnown = knownLimits.every(
    (value) => value !== undefined && Number.isFinite(value)
  );
  const quantity = allConstraintsKnown
    ? Math.max(0, Math.floor(Math.min(...knownLimits)))
    : 0;
  const timingValid =
    donor.transferEtaHours !== undefined &&
    (targetForecast.stockoutInHours === null ||
      donor.transferEtaHours < targetForecast.stockoutInHours);
  const feasible =
    allConstraintsKnown &&
    coordinatesAvailable &&
    quantity > 0 &&
    timingValid &&
    constraints.length === 0;

  if (
    allConstraintsKnown &&
    quantity <= 0 &&
    requiredQuantity > 0 &&
    constraints.length === 0
  ) {
    constraints.push("No positive transfer quantity satisfies all capacity limits.");
  }

  return {
    feasible,
    donor,
    quantity,
    requiredQuantity,
    destinationShelfSpace,
    donorSurplus,
    safeDonorSurplus,
    donorDemandUntilReplenishment,
    donorAvailableAtTransfer,
    distanceKm:
      target.latitude != null &&
      target.longitude != null &&
      donor.latitude != null &&
      donor.longitude != null &&
      validCoordinate(Number(target.latitude), Number(target.longitude)) &&
      validCoordinate(Number(donor.latitude), Number(donor.longitude))
        ? haversineKm(
            Number(target.latitude),
            Number(target.longitude),
            Number(donor.latitude),
            Number(donor.longitude)
          )
        : null,
    targetForecast,
    constraints,
  };
}

function findPendingAction(storeId, sku, scenario) {
  return actions.find(
    (action) =>
      action.storeId === storeId &&
      action.sku === sku &&
      action.scenario === scenario &&
      action.status === "PENDING"
  );
}

function createRecommendation(target, scenario) {
  const assessment = transferAssessment(target, scenario);
  if (assessment.requiredQuantity <= 0) {
    return {
      storeId: target.storeId,
      sku: target.sku,
      predictedStockoutHour: assessment.targetForecast.stockoutInHours,
      recommendation: {
        action: "WAIT",
        feasible: true,
        quantity: 0,
        reason: "Current stock and listed deliveries cover demand until the next truck.",
        constraints: [],
      },
      requiresApproval: false,
      actionRecord: null,
    };
  }

  let action = findPendingAction(target.storeId, target.sku, scenario.key);
  if (!action) {
    action = {
      id: String(nextActionId++),
      status: "PENDING",
      action: assessment.feasible ? "TRANSFER" : "REVIEW",
      feasible: assessment.feasible,
      fromStore: assessment.donor?.storeId ?? null,
      toStore: target.storeId,
      storeId: target.storeId,
      quantity: assessment.quantity,
      requiredQuantity: assessment.requiredQuantity,
      sku: target.sku,
      product: target.product,
      reason: assessment.feasible
        ? `Store ${assessment.donor.storeId} can provide ${assessment.quantity} units without violating the configured constraints.`
        : "A stockout risk exists, but transfer feasibility is unverified or constrained.",
      constraints: assessment.constraints,
      scenario: scenario.key,
      estimatedUnfilledUnitsAfterAction: Math.max(
        0,
        assessment.requiredQuantity - assessment.quantity
      ),
    };
    actions.push(action);
    recordActionHistory(action, null, "PENDING", { source: "deterministic recommendation" });
    persistRuntimeState();
  }

  return {
    storeId: target.storeId,
    sku: target.sku,
    predictedStockoutHour: assessment.targetForecast.stockoutInHours,
    recommendation: action,
    requiresApproval: true,
    actionRecord: action,
  };
}

function validateInventoryInput(body) {
  const required = [
    "storeId",
    "sku",
    "product",
    "stock",
    "hourlyDemand",
    "shelfCapacity",
    "truckArrivalHour",
  ];
  if (!body || required.some((key) => body[key] === undefined)) {
    return "All inventory fields are required.";
  }
  if (
    !Number.isInteger(Number(body.storeId)) ||
    Number(body.storeId) <= 0 ||
    typeof body.sku !== "string" ||
    !body.sku.trim() ||
    typeof body.product !== "string" ||
    !body.product.trim()
  ) {
    return "Store ID, SKU, and product must be valid.";
  }
  if (
    (body.latitude !== undefined || body.longitude !== undefined) &&
    !validCoordinate(Number(body.latitude), Number(body.longitude))
  ) {
    return "Latitude and longitude must be supplied together as a valid coordinate pair.";
  }
  for (const key of ["storeName", "locality", "city", "state", "locationSource"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      return `${key} must be a string.`;
    }
  }
  for (const key of [
    "stock",
    "hourlyDemand",
    "shelfCapacity",
    "truckArrivalHour",
  ]) {
    if (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0) {
      return `${key} must be a non-negative number.`;
    }
  }
  if (Number(body.stock) > Number(body.shelfCapacity)) {
    return "Shelf capacity must be at least current stock.";
  }
  for (const key of [
    "safetyStock",
    "unitPrice",
    "transferEtaHours",
    "transportCapacity",
    "unitCost",
    "earlierTruckArrivalHour",
    "earlierTruckUnits",
  ]) {
    if (body[key] !== undefined && body[key] !== null) {
      if (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0) {
        return `${key} must be a non-negative number.`;
      }
    }
  }
  if (
    body.safetyStock !== undefined &&
    Number(body.safetyStock) > Number(body.stock)
  ) {
    return "safetyStock cannot exceed current stock.";
  }
  if (
    body.shelfSpaceShareable !== undefined &&
    typeof body.shelfSpaceShareable !== "boolean"
  ) {
    return "shelfSpaceShareable must be a boolean.";
  }
  if (
    body.earlierTruckAvailable !== undefined &&
    typeof body.earlierTruckAvailable !== "boolean"
  ) {
    return "earlierTruckAvailable must be a boolean.";
  }
  return null;
}

function validateStoreInput(body) {
  if (
    !body ||
    !Number.isInteger(Number(body.storeId)) ||
    Number(body.storeId) <= 0 ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    typeof body.locality !== "string" ||
    !bengaluruAreas.some((area) => area.name === body.locality.trim())
  ) {
    return "Provide a positive store ID, name, and one of the configured Bengaluru areas.";
  }
  for (const key of ["address", "city", "state", "locationSource"]) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
      return `${key} must be a string.`;
    }
  }
  if (
    (body.latitude !== undefined || body.longitude !== undefined) &&
    !validCoordinate(Number(body.latitude), Number(body.longitude))
  ) {
    return "Latitude and longitude must be supplied together as a valid coordinate pair.";
  }
  if (
    body.latitude !== undefined &&
    (typeof body.locationSource !== "string" || !body.locationSource.trim())
  ) {
    return "Coordinates require a source description and cannot be marked verified by this demo API.";
  }
  return null;
}

app.get("/", (req, res) => {
  res.json({
    project: "Zipcart AI",
    message: "Backend is running successfully!",
    status: "OK",
  });
});

app.get("/health", async (req, res, next) => {
    if (database.enabled) {
      try {
        const check = await database.query(
          "SELECT to_regclass('public.inventory') AS inventory_table"
        );
        if (!check.rows[0].inventory_table) {
          return res.status(503).json({
            status: "ERROR",
            storage: "postgresql",
            error: "Database migrations have not been applied.",
          });
        }
        return res.json({ status: "OK", storage: "postgresql" });
      } catch (error) {
        return next(error);
      }
    }
    return res.json({ status: "OK", storage: "json demo persistence" });
});
app.get("/api/health", (req, res) => {
    return res.json({ status: "OK", storage: "json demo persistence" });
});

app.get("/api/stores", (req, res) => {
    const ids = new Set([
      ...storeRecords.map((store) => store.storeId),
      ...inventory.map((item) => item.storeId),
    ]);
    const stores = [...ids].map((storeId) => {
      const record = storeRecords.find((store) => store.storeId === storeId);
      const item = inventory.find((entry) => entry.storeId === storeId);
      return {
        ...(record || {}),
        storeId,
        name: record?.name || item?.storeName || `Store ${storeId}`,
        address: record?.address || null,
        locality: record?.locality || item?.locality || null,
        city: record?.city || item?.city || null,
        state: record?.state || item?.state || null,
        postalCode: record?.postalCode || null,
        latitude: record?.latitude ?? item?.latitude ?? null,
        longitude: record?.longitude ?? item?.longitude ?? null,
        geographicSourceId: record?.geographicSourceId || null,
        locationSource: record?.locationSource || item?.locationSource || "legacy demo inventory",
        storeType: record?.storeType || "simulated operational location",
        verificationStatus: record?.verificationStatus || "simulated",
        active: record?.active !== false,
      };
    }).filter((store) => store.active);
    res.json({
      stores,
      attribution: "© OpenStreetMap contributors",
      note: "Only stores marked active are listed. Simulated locations and illustrative coordinates are labelled.",
    });
});

app.get("/api/bengaluru-areas", (req, res) => {
  res.json({
    areas: bengaluruAreas.map((area) => area.name),
    source: "configured Bengaluru area list",
  });
});

app.post("/api/stores", (req, res) => {
  const error = validateStoreInput(req.body);
  if (error) return res.status(400).json({ error });
  const storeId = Number(req.body.storeId);
  if (storeRecords.some((store) => store.storeId === storeId) ||
      inventory.some((item) => item.storeId === storeId)) {
    return res.status(409).json({ error: "This store ID already exists." });
  }
  const store = {
    storeId,
    name: req.body.name.trim(),
    address: req.body.address?.trim() || null,
    locality: req.body.locality.trim(),
    city: req.body.city?.trim() || "Bengaluru",
    state: req.body.state?.trim() || "Karnataka",
    latitude: req.body.latitude === undefined ? null : Number(req.body.latitude),
    longitude: req.body.longitude === undefined ? null : Number(req.body.longitude),
    locationSource: req.body.locationSource?.trim() || "coordinates unavailable",
    storeType: "simulated operational location",
    verificationStatus: "simulated",
    active: req.body.active !== false,
  };
  storeRecords.push(store);
  persistRuntimeState();
  return res.status(201).json(store);
});

app.put("/api/stores/:storeId", (req, res) => {
  const storeId = Number(req.params.storeId);
  let existing = storeRecords.find((store) => store.storeId === storeId);
  if (!existing) {
    const item = inventory.find((record) => record.storeId === storeId);
    if (!item) return res.status(404).json({ error: "Store not found." });
    existing = {
      storeId,
      name: item.storeName || `Store ${storeId}`,
      address: null,
      locality: item.locality || null,
      city: item.city || "Bengaluru",
      state: item.state || "Karnataka",
      latitude: item.latitude ?? null,
      longitude: item.longitude ?? null,
      locationSource: item.locationSource || "coordinates unavailable",
      storeType: "simulated operational location",
      verificationStatus: "simulated",
      active: true,
    };
    storeRecords.push(existing);
  }
  const error = validateStoreInput({ ...existing, ...req.body, storeId });
  if (error) return res.status(400).json({ error });
  Object.assign(existing, {
    name: req.body.name.trim(),
    address: req.body.address?.trim() || null,
    locality: req.body.locality.trim(),
    city: req.body.city?.trim() || "Bengaluru",
    state: req.body.state?.trim() || "Karnataka",
    latitude: req.body.latitude === undefined ? existing.latitude : Number(req.body.latitude),
    longitude: req.body.longitude === undefined ? existing.longitude : Number(req.body.longitude),
    locationSource: req.body.locationSource?.trim() || "coordinates unavailable",
    active: req.body.active !== false,
  });
  persistRuntimeState();
  return res.json(existing);
});

app.get("/api/stores/nearby", (req, res) => {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    const radiusKm = req.query.radiusKm === undefined ? 5 : Number(req.query.radiusKm);
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(radiusKm) ||
      radiusKm <= 0 ||
      radiusKm > 100
    ) {
      return res.status(400).json({
        error: "Provide valid latitude, longitude, and radiusKm (0-100).",
      });
    }
    return res.json({
      stores: [],
      radiusKm,
      distanceType: "straight-line haversine distance",
      note: "The JSON demo store records have no verified coordinates.",
    });
});

app.get("/api/stores/:storeId", (req, res) => {
    const storeId = Number(req.params.storeId);
    const records = inventory.filter((item) => item.storeId === storeId);
    if (!records.length) return res.status(404).json({ error: "Store not found." });
    return res.json({
      storeId,
      name: records[0].storeName || `Store ${storeId}`,
      address: null,
      locality: records[0].locality || null,
      city: records[0].city || null,
      state: null,
      latitude: records[0].latitude ?? null,
      longitude: records[0].longitude ?? null,
      storeType: "simulated operational location",
      verificationStatus: "simulated",
      inventory: records,
    });
});

app.get("/api/stock-rescue", (req, res) => {
  const storeId = Number(req.query.storeId);
  const sku = typeof req.query.sku === "string" ? req.query.sku.trim() : "";
  const radiusKm = req.query.radiusKm === undefined ? 10 : Number(req.query.radiusKm);
  if (!Number.isInteger(storeId) || storeId <= 0 || !sku || !Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 100) {
    return res.status(400).json({
      error: "Provide a positive storeId, a SKU, and a radiusKm between 0 and 100.",
    });
  }
  const target = findInventory(storeId, sku);
  if (!target) {
    return res.status(404).json({ error: "Selected store does not carry this SKU." });
  }
  const scenario = getScenario({ scenario: req.query.scenario || "baseline" });
  if (scenario.error) return res.status(400).json({ error: scenario.error });
  const targetLocation = storeLocation(target);
  const hasTargetCoordinates =
    targetLocation.latitude != null &&
    targetLocation.longitude != null &&
    validCoordinate(Number(targetLocation.latitude), Number(targetLocation.longitude));
  const candidates = inventory
    .filter((item) => item.storeId !== target.storeId && item.sku === sku)
    .map((item) => {
      const assessment = transferAssessment(target, scenario, item.storeId);
      const donorLocation = storeLocation(item);
      const distanceKm =
        hasTargetCoordinates &&
        donorLocation.latitude != null &&
        donorLocation.longitude != null &&
        validCoordinate(Number(donorLocation.latitude), Number(donorLocation.longitude))
          ? haversineKm(
              Number(targetLocation.latitude),
              Number(targetLocation.longitude),
              Number(donorLocation.latitude),
              Number(donorLocation.longitude)
            )
          : null;
      return {
        storeId: item.storeId,
        name: item.storeName || `Store ${item.storeId}`,
        area: item.locality || null,
        stock: item.stock,
        hourlyDemand: item.hourlyDemand,
        safetyStock: item.safetyStock ?? null,
        shelfCapacity: item.shelfCapacity,
        truckArrivalHour: item.truckArrivalHour,
        distanceKm,
        distanceSource: distanceKm === null ? "unavailable" : "straight-line Haversine",
        safeTransferableSurplus: assessment.safeDonorSurplus ?? null,
        stockAvailableAtTransfer: assessment.donorAvailableAtTransfer ?? null,
        donorDemandUntilReplenishment: assessment.donorDemandUntilReplenishment,
        transferEtaHours: item.transferEtaHours ?? null,
        estimatedTransferQuantity: assessment.quantity,
        feasible: assessment.feasible,
        constraints: assessment.constraints,
        inventorySource: item.inventorySource || "JSON demo persistence",
        verificationStatus: item.verificationStatus || "simulated",
      };
    })
    .filter((candidate) => candidate.distanceKm === null || candidate.distanceKm <= radiusKm)
    .sort((left, right) => {
      if (left.distanceKm !== null && right.distanceKm === null) return -1;
      if (left.distanceKm === null && right.distanceKm !== null) return 1;
      if (left.distanceKm !== null && right.distanceKm !== null && left.distanceKm !== right.distanceKm) {
        return left.distanceKm - right.distanceKm;
      }
      return right.stock - left.stock || left.storeId - right.storeId;
    });
  const targetForecast = buildForecast(target, Math.max(24, Math.ceil(target.truckArrivalHour)), scenario);
  res.json({
    target: {
      storeId,
      sku,
      product: target.product,
      area: target.locality || null,
      currentStock: target.stock,
      hourlyDemand: target.hourlyDemand,
      truckArrivalHour: target.truckArrivalHour,
      stockoutInHours: targetForecast.stockoutInHours,
      expectedShortageBeforeTruck: targetForecast.expectedShortageBeforeTruck,
      shelfCapacity: target.shelfCapacity,
    },
    candidates,
    radiusKm,
    proximityVerified: hasTargetCoordinates && candidates.every((candidate) => candidate.distanceKm !== null),
    dataQuality: "JSON persistence; transfer inputs are simulated. Candidates without coordinates are not verified as nearby.",
  });
});

app.post("/api/transfers/proposals", (req, res) => {
  const storeId = Number(req.body?.storeId);
  const donorStoreId = Number(req.body?.donorStoreId);
  const sku = typeof req.body?.sku === "string" ? req.body.sku.trim() : "";
  const scenario = getScenario({ scenario: req.body?.scenario || "baseline" });
  if (!Number.isInteger(storeId) || storeId <= 0 || !Number.isInteger(donorStoreId) || donorStoreId <= 0 || !sku || scenario.error) {
    return res.status(400).json({ error: "Provide a valid destination store, donor store, SKU, and scenario." });
  }
  const target = findInventory(storeId, sku);
  if (!target) return res.status(404).json({ error: "Destination store does not carry this SKU." });
  const assessment = transferAssessment(target, scenario, donorStoreId);
  if (assessment.requiredQuantity <= 0 || !assessment.feasible) {
    return res.status(409).json({
      error: "This transfer cannot be proposed as feasible with the current inputs.",
      requiredQuantity: assessment.requiredQuantity,
      constraints: assessment.constraints,
    });
  }
  const existing = actions.find(
    (action) =>
      action.status === "PENDING" &&
      action.action === "TRANSFER" &&
      action.toStore === storeId &&
      action.fromStore === donorStoreId &&
      action.sku === sku &&
      action.scenario === scenario.key
  );
  if (existing) {
    return res.json({ message: "A matching transfer request is already pending manager approval.", action: existing });
  }
  const action = {
    id: String(nextActionId++),
    status: "PENDING",
    action: "TRANSFER",
    feasible: true,
    fromStore: donorStoreId,
    toStore: storeId,
    storeId,
    quantity: assessment.quantity,
    requiredQuantity: assessment.requiredQuantity,
    sku,
    product: target.product,
    reason: `Store ${donorStoreId} has ${assessment.safeDonorSurplus} units of calculated safe surplus; the proposed quantity is capped by demand, shelf space, and transport capacity.`,
    constraints: [],
    scenario: scenario.key,
    estimatedUnfilledUnitsAfterAction: Math.max(0, assessment.requiredQuantity - assessment.quantity),
  };
  actions.push(action);
  recordActionHistory(action, null, "PENDING", { source: "simulated stock rescue proposal" });
  persistRuntimeState();
  return res.status(201).json({
    message: "Simulated transfer plan created; manager approval is required and no inventory was moved.",
    action,
  });
});

app.get("/api/hourly-sales", (req, res) => {
    res.json({
      records: [],
      dataQuality: "No hourly sales history configured in JSON demo storage.",
    });
});
app.get("/api/events", (req, res) => {
    res.json({
      events: [],
      dataQuality: "No dated event records configured in JSON demo storage.",
    });
});
app.get("/api/warehouse-inventory", (req, res) => {
    res.json({
      inventory: [],
      dataQuality: "Warehouse availability is not configured in JSON demo storage.",
    });
});
app.get("/api/trucks", (req, res) => {
    res.json({
      trucks: [],
      dataQuality: "Only relative truck ETAs are present in JSON demo inventory.",
    });
});
app.get("/api/riders", (req, res) => {
    res.json({
      riders: [],
      dataQuality: "Rider availability is not configured in JSON demo storage.",
  });
});

app.get("/api/scenarios", (req, res) => {
  res.json({
    baseline: { label: "Baseline hourly demand", upliftPercent: 0 },
    ...Object.fromEntries(
      Object.entries(scenarioConfig).map(([key, config]) => [
        key,
        { ...config },
      ])
    ),
  });
});

app.get("/api/inventory", (req, res) => {
  res.json(
    inventory.map((item) => ({
      ...item,
      inventorySource: item.inventorySource || "JSON demo persistence",
      verificationStatus: item.verificationStatus || "simulated",
    }))
  );
});

app.post("/api/inventory", (req, res) => {
  const validationError = validateInventoryInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const storeId = Number(req.body.storeId);
  const sku = req.body.sku.trim();
  if (findInventory(storeId, sku)) {
    return res.status(409).json({ error: "This SKU already exists at this store." });
  }

  const item = {
    storeId,
    sku,
    product: req.body.product.trim(),
    stock: Number(req.body.stock),
    hourlyDemand: Number(req.body.hourlyDemand),
    shelfCapacity: Number(req.body.shelfCapacity),
    truckArrivalHour: Number(req.body.truckArrivalHour),
    ...(req.body.storeName ? { storeName: String(req.body.storeName).trim() } : {}),
    ...(req.body.locality ? { locality: req.body.locality.trim() } : {}),
    ...(req.body.city ? { city: req.body.city.trim() } : {}),
    ...(req.body.state ? { state: req.body.state.trim() } : {}),
    ...(req.body.locationSource ? { locationSource: req.body.locationSource.trim() } : {}),
    ...(req.body.latitude !== undefined
      ? { latitude: Number(req.body.latitude), longitude: Number(req.body.longitude) }
      : {}),
    ...[
      "safetyStock",
      "unitPrice",
      "unitCost",
      "transferEtaHours",
      "transportCapacity",
      "earlierTruckArrivalHour",
      "earlierTruckUnits",
      "shelfSpaceShareable",
      "earlierTruckAvailable",
    ].reduce((fields, key) => {
      if (req.body[key] !== undefined) {
        fields[key] =
          typeof req.body[key] === "boolean"
            ? req.body[key]
            : Number(req.body[key]);
      }
      return fields;
    }, {}),
    category:
      typeof req.body.category === "string"
        ? req.body.category
        : inferCategory(req.body.product.trim()),
    inventorySource: "JSON demo persistence",
    verificationStatus: "simulated",
  };
  if (item.unitPrice !== undefined && item.unitCost !== undefined) {
    item.unitMargin = item.unitPrice - item.unitCost;
  }
  inventory.push(item);
  persistRuntimeState();
  return res.status(201).json(item);
});

app.put("/api/inventory/:storeId/:sku", (req, res) => {
  const item = findInventory(req.params.storeId, req.params.sku);
  if (!item) return res.status(404).json({ error: "Product not found in this store." });
  const { stock, hourlyDemand, shelfCapacity } = req.body || {};
  if (
    !Number.isInteger(stock) ||
    stock < 0 ||
    !Number.isFinite(hourlyDemand) ||
    hourlyDemand < 0 ||
    !Number.isInteger(shelfCapacity) ||
    shelfCapacity < stock
  ) {
    return res.status(400).json({
      error: "Provide whole non-negative stock and shelf capacity, and non-negative hourly demand; capacity must cover stock.",
    });
  }
  if (
    req.body.safetyStock !== undefined &&
    (!Number.isInteger(req.body.safetyStock) ||
      req.body.safetyStock < 0 ||
      req.body.safetyStock > stock)
  ) {
    return res.status(400).json({
      error: "Safety stock must be a whole number within current stock.",
    });
  }
  Object.assign(item, { stock, hourlyDemand, shelfCapacity });
  if (req.body.safetyStock !== undefined) item.safetyStock = req.body.safetyStock;
  item.inventorySource = "JSON demo persistence update";
  item.verificationStatus = "simulated";
  persistRuntimeState();
  return res.json(item);
});

app.get("/api/inventory/:storeId/:sku", (req, res) => {
  const item = findInventory(req.params.storeId, req.params.sku);
  if (!item) {
    return res.status(404).json({ error: "Product not found in this store." });
  }
  return res.json(item);
});

app.get("/api/forecast/:storeId/:sku", (req, res) => {
  const item = findInventory(req.params.storeId, req.params.sku);
  if (!item) {
    return res.status(404).json({ error: "Product not found." });
  }
  const hours = Number(req.query.hours || 4);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
    return res.status(400).json({ error: "Hours must be an integer from 1 to 24." });
  }
  const scenario = getScenario(req.query);
  if (scenario.error) {
    return res.status(400).json({ error: scenario.error });
  }
  return res.json(buildForecast(item, hours, scenario));
});

app.get("/api/action-comparison/:storeId/:sku", (req, res) => {
  const target = findInventory(req.params.storeId, req.params.sku);
  if (!target) return res.status(404).json({ error: "Product not found." });
  const scenario = getScenario(req.query);
  if (scenario.error) return res.status(400).json({ error: scenario.error });
  const assessment = transferAssessment(target, scenario);
  const forecast = assessment.targetForecast;
  const shortage = Math.ceil(forecast.expectedShortageBeforeTruck);
  const transfer = {
    type: "TRANSFER",
    title: "Transfer stock from another store",
    feasible: assessment.feasible,
    quantity: assessment.quantity,
    fromStore: assessment.donor?.storeId ?? null,
    reason: assessment.feasible
      ? `Store ${assessment.donor.storeId} can provide ${assessment.quantity} units within configured constraints.`
      : "A transfer cannot be marked feasible until all required donor and logistics checks pass.",
    constraints: assessment.constraints,
    expectedShortage: Math.max(0, shortage - assessment.quantity),
  };
  const earlyAvailable = target.earlierTruckAvailable === true;
  const timingValid =
    target.earlierTruckArrivalHour !== undefined &&
    (forecast.stockoutInHours === null ||
      target.earlierTruckArrivalHour < forecast.stockoutInHours);
  const quantityValid =
    target.earlierTruckUnits !== undefined &&
    target.earlierTruckUnits >= shortage;
  const earlierTruck = {
    type: "EARLIER_TRUCK",
    title: "Request an earlier truck",
    feasible: earlyAvailable && timingValid && quantityValid,
    quantity: target.earlierTruckUnits ?? 0,
    fromStore: null,
    reason: earlyAvailable
      ? "Recorded early-truck availability is compared with stockout timing and required units."
      : "No confirmed earlier-truck availability is recorded.",
    constraints: [
      ...(!earlyAvailable ? ["Dispatch confirmation of earlier arrival is missing."] : []),
      ...(target.earlierTruckArrivalHour === undefined ? ["Earlier arrival time is missing."] : []),
      ...(target.earlierTruckUnits === undefined ? ["Confirmed delivery quantity is missing."] : []),
      ...(!timingValid ? ["Earlier delivery does not precede the predicted stockout."] : []),
      ...(!quantityValid ? ["Confirmed quantity does not cover the forecast shortage."] : []),
    ],
    expectedShortage: Math.max(
      0,
      shortage - (earlyAvailable && timingValid ? target.earlierTruckUnits ?? 0 : 0)
    ),
  };
  const shelfSwap = {
    type: "SHELF_SWAP",
    title: "Reassign shelf space from a slow seller",
    feasible: false,
    quantity: 0,
    fromStore: null,
    reason: "Shelf space does not add stock and verified placement/replenishment data is missing.",
    constraints: ["Shelf-slot assignment and product dimensions are not configured."],
    expectedShortage: shortage,
  };
  const wait = {
    type: "WAIT",
    title: "Wait for the scheduled truck",
    feasible: true,
    quantity: 0,
    fromStore: null,
    reason: `Baseline comparison: the scheduled truck arrives in ${target.truckArrivalHour} hours.`,
    constraints: ["No delivery changes or action costs are assumed."],
    expectedShortage: shortage,
  };
  const options = [transfer, earlierTruck, shelfSwap, wait].map((option) => ({
    ...option,
    lostSalesRevenue:
      target.unitPrice === undefined ? null : option.expectedShortage * target.unitPrice,
    lostGrossMargin:
      target.unitMargin === undefined ? null : option.expectedShortage * target.unitMargin,
    actionCost: null,
  }));
  const preferred =
    options.find((option) => option.type === "TRANSFER" && option.feasible) ||
    options.find((option) => option.type === "EARLIER_TRUCK" && option.feasible) ||
    null;
  return res.json({
    storeId: target.storeId,
    sku: target.sku,
    scenario: scenario.key,
    baselineShortage: shortage,
    preferredOption: preferred?.type ?? null,
    options,
    reasoning: [
      { step: "Observe inventory and delivery schedule", status: "passed", detail: `${target.stock} units on hand; truck in ${target.truckArrivalHour} hours.` },
      { step: "Forecast hourly demand", status: "passed", detail: `Baseline ${target.hourlyDemand} units per hour; ${scenario.config?.source || "baseline demand source is unspecified"}.` },
      { step: "Detect possible stockout", status: "passed", detail: `${shortage} unmet units forecast before the next truck.` },
      { step: "Find nearby potential donor stores", status: assessment.donor ? "passed" : "missing", detail: assessment.donor ? `Same-SKU candidate: Store ${assessment.donor.storeId}.` : "No same-SKU donor record is available." },
      { step: "Validate safety stock, shelf capacity and logistics", status: assessment.feasible ? "passed" : "needs_verification", detail: assessment.constraints.join(" ") || "All listed constraints pass." },
      { step: "Compare transfer, earlier truck, waiting and shelf swap", status: "passed", detail: preferred ? `${preferred.title} is supported by the available data.` : "No intervention is fully verified; waiting is the baseline comparison." },
      { step: "Request manager approval", status: preferred ? "pending" : "needs_verification", detail: preferred ? "Simulated action requires manager approval." : "Manager intervention is required to resolve missing constraints." },
    ],
  });
});

app.get("/api/recommendations/:storeId/:sku", (req, res) => {
  const target = findInventory(req.params.storeId, req.params.sku);
  if (!target) {
    return res.status(404).json({ error: "Target product not found." });
  }
  const scenario = getScenario(req.query);
  if (scenario.error) {
    return res.status(400).json({ error: scenario.error });
  }
  return res.json(createRecommendation(target, scenario));
});

app.get("/api/actions", (req, res) => {
  res.json(actions);
});

app.get("/api/actions/:actionId/history", (req, res) => {
  const action = actions.find((item) => item.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: "Action not found." });
  return res.json(actionHistory.filter((entry) => entry.actionId === action.id));
});

app.post("/api/actions/:actionId", (req, res) => {
  const status = String(req.body?.status || "").toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(status)) {
    return res.status(400).json({ error: "Status must be APPROVED or REJECTED." });
  }
  const action = actions.find((item) => item.id === req.params.actionId);
  if (!action) {
    return res.status(404).json({
      error: "Action not found. Generate a recommendation first.",
    });
  }
  if (action.status !== "PENDING") {
    return res.status(409).json({ error: "This action has already been processed." });
  }

  if (status === "APPROVED") {
    if (action.action !== "TRANSFER" || action.feasible !== true) {
      return res.status(409).json({
        error: "This recommendation is unverified or infeasible and cannot be approved.",
        constraints: action.constraints,
      });
    }

    const donor = findInventory(action.fromStore, action.sku);
    const target = findInventory(action.toStore, action.sku);
    if (!donor || !target) {
      return res.status(404).json({ error: "Source or destination inventory not found." });
    }
    const scenario = getScenario({ scenario: action.scenario });
    const latestAssessment = transferAssessment(target, scenario, donor.storeId);
    if (
      !latestAssessment.feasible ||
      latestAssessment.donor?.storeId !== donor.storeId ||
      latestAssessment.quantity < action.quantity ||
      target.stock + action.quantity > target.shelfCapacity
    ) {
      return res.status(409).json({
        error: "Transfer feasibility changed; the plan was not approved.",
        constraints: latestAssessment.constraints,
      });
    }
  }

  const previousStatus = action.status;
  action.status = status;
  action.processedAt = new Date().toISOString();
  recordActionHistory(action, previousStatus, status, {
    inventoryChanged: false,
    note: status === "APPROVED"
      ? "Approval records a plan only; inventory changes only on simulated completion."
      : "Rejected plan leaves inventory unchanged.",
  });
  persistRuntimeState();
  return res.json({
    message: status === "APPROVED"
      ? "Transfer plan approved in simulation; inventory remains unchanged until simulated completion."
      : "Action rejected in simulation; inventory was not changed.",
    action,
    inventory,
  });
});

app.post("/api/actions/:actionId/complete", (req, res) => {
  const action = actions.find((item) => item.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: "Action not found." });
  if (action.status !== "APPROVED" || action.action !== "TRANSFER" || !action.feasible) {
    return res.status(409).json({
      error: "Only an approved, verified transfer plan can be completed in simulation.",
    });
  }
  const donor = findInventory(action.fromStore, action.sku);
  const target = findInventory(action.toStore, action.sku);
  if (!donor || !target) {
    return res.status(404).json({ error: "Source or destination inventory not found." });
  }
  const scenario = getScenario({ scenario: action.scenario });
  const assessment = transferAssessment(target, scenario, donor.storeId);
  if (
    !assessment.feasible ||
    assessment.quantity < action.quantity ||
    target.stock + action.quantity > target.shelfCapacity
  ) {
    return res.status(409).json({
      error: "Transfer feasibility changed; simulated inventory was not modified.",
      constraints: assessment.constraints,
    });
  }
  const previousStatus = action.status;
  donor.stock -= action.quantity;
  target.stock += action.quantity;
  action.status = "COMPLETED";
  action.completedAt = new Date().toISOString();
  action.processedAt = action.completedAt;
  recordActionHistory(action, previousStatus, "COMPLETED", {
    inventoryChanged: true,
    sourceStock: donor.stock,
    destinationStock: target.stock,
    simulated: true,
  });
  persistRuntimeState();
  return res.json({
    message: "Transfer completed in simulation; no physical dispatch occurred.",
    action,
    inventory,
  });
});

app.get("/api/deliveries", (req, res) => {
  res.json(
    deliveries.map(({ storeId, sku, hour, quantity }) => ({
      storeId,
      sku,
      arrivalHour: hour,
      quantity,
      dataSource: "JSON demo persistence",
    }))
  );
});

app.post("/api/deliveries", (req, res) => {
  const { storeId, sku, hour, quantity } = req.body || {};
  if (
    !Number.isInteger(Number(storeId)) ||
    typeof sku !== "string" ||
    !Number.isInteger(hour) ||
    hour < 1 ||
    hour > 24 ||
    !Number.isInteger(quantity) ||
    quantity <= 0
  ) {
    return res.status(400).json({
      error: "Provide a valid storeId, sku, hour (1-24), and positive quantity.",
    });

    app.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      console.error("Zipcart API request failed:", error);
      return res.status(error.status || 500).json({
        error: error.status ? error.message : "The backend could not complete the request.",
      });
    });
  }
  const item = findInventory(storeId, sku);
  if (!item) {
    return res.status(404).json({ error: "Product not found in this store." });
  }
  if (item.stock + quantity > item.shelfCapacity) {
    return res.status(400).json({ error: "Delivery exceeds shelf capacity." });
  }
  const delivery = { storeId: Number(storeId), sku, hour, quantity };
  deliveries.push(delivery);
  persistRuntimeState();
  return res.status(201).json({
    message: "Simulated delivery scheduled.",
    delivery,
  });
});

if (require.main === module) {
  app.listen(port, host, () => {
    console.log(`Zipcart AI backend running at http://${host}:${port}`);
  });
}

module.exports = {
  app,
  buildForecast,
  resetState,
  transferAssessment,
};
