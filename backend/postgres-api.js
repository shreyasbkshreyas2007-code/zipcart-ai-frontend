const db = require("./db");
const { areas: bengaluruAreas } = require("./demo-bengaluru-network");

const EARTH_RADIUS_KM = 6371.0088;

function validCoordinate(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function haversineKm(latitude1, longitude1, latitude2, longitude2) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latDelta = radians(latitude2 - latitude1);
  const lonDelta = radians(longitude2 - longitude1);
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(radians(latitude1)) *
      Math.cos(radians(latitude2)) *
      Math.sin(lonDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)));
}

function inventoryIsFresh(lastUpdatedAt, now = Date.now(), maxAgeHours = 24) {
  const timestamp = Date.parse(lastUpdatedAt);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 5 * 60 * 1000 &&
    now - timestamp <= maxAgeHours * 3600000
  );
}

function parseScenario(query, scenarioConfig) {
  const key = query.scenario || "baseline";
  if (key === "baseline") return { key, config: null, startHour: 1 };
  const config = scenarioConfig[key];
  const startHour =
    query.eventStartHour === undefined
      ? config?.defaultStartHour
      : Number(query.eventStartHour);
  if (
    !config ||
    !Number.isInteger(startHour) ||
    startHour < 1 ||
    startHour > 24
  ) {
    return null;
  }
  return { key, config, startHour };
}

function itemFromRow(row) {
  return {
    storeId: Number(row.store_id),
    storeName: row.store_name,
    sku: row.sku,
    product: row.product_name,
    category: row.category,
    stock: Number(row.current_stock),
    hourlyDemand: Number(row.hourly_demand),
    shelfCapacity: Number(row.shelf_capacity),
    truckArrivalHour: row.truck_eta_hours == null ? 0 : Math.max(0, Number(row.truck_eta_hours)),
    safetyStock: row.safety_stock == null ? undefined : Number(row.safety_stock),
    unitPrice: row.selling_price == null ? undefined : Number(row.selling_price),
    unitCost: row.unit_cost == null ? undefined : Number(row.unit_cost),
    unitMargin: row.unit_margin == null ? undefined : Number(row.unit_margin),
    transferEtaHours: row.transfer_eta_hours == null ? undefined : Number(row.transfer_eta_hours),
    transportCapacity: row.transport_capacity == null ? undefined : Number(row.transport_capacity),
    earlierTruckAvailable: row.earlier_truck_available ?? undefined,
    earlierTruckArrivalHour: row.earlier_truck_arrival_hour == null ? undefined : Number(row.earlier_truck_arrival_hour),
    earlierTruckUnits: row.earlier_truck_units == null ? undefined : Number(row.earlier_truck_units),
    shelfSpaceShareable: row.shelf_space_shareable ?? undefined,
    inventorySource: row.inventory_source,
    verificationStatus: row.inventory_verification_status,
    lastUpdatedAt: row.inventory_updated_at,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    locality: row.locality,
    city: row.city,
    locationSource: row.location_source,
  };
}

async function getInventoryRows(client = db) {
  const result = await client.query(`
    SELECT i.store_id, s.name AS store_name, s.latitude, s.longitude,
      s.locality, s.city, s.location_source, p.sku, p.product_name, p.category,
      p.selling_price, p.unit_cost,
      COALESCE(p.unit_margin, p.selling_price - p.unit_cost) AS unit_margin,
      i.current_stock, i.safety_stock, i.shelf_capacity,
      i.baseline_hourly_demand AS hourly_demand,
      i.transfer_eta_hours, i.transport_capacity, i.earlier_truck_available,
      i.earlier_truck_arrival_hour, i.earlier_truck_units,
      i.shelf_space_shareable, i.inventory_source,
      i.verification_status AS inventory_verification_status,
      i.last_updated_at AS inventory_updated_at,
      (SELECT GREATEST(0, EXTRACT(EPOCH FROM (t.scheduled_arrival_at - NOW())) / 3600)
       FROM trucks t
       WHERE t.store_id = i.store_id AND t.delivery_status IN ('scheduled', 'in_transit')
       ORDER BY t.scheduled_arrival_at LIMIT 1) AS truck_eta_hours
    FROM inventory i
    JOIN stores s ON s.store_id = i.store_id
    JOIN products p ON p.sku = i.sku
    WHERE s.active = TRUE
    ORDER BY i.store_id, p.product_name
  `);
  return result.rows.map(itemFromRow);
}

async function findInventory(storeId, sku, client = db) {
  const inventory = await getInventoryRows(client);
  return inventory.find((item) => item.storeId === Number(storeId) && item.sku === sku);
}

function categoryFor(item) {
  if (item.category) return item.category.toLowerCase();
  const name = item.product.toLowerCase();
  if (/drink|cola|soda|water|juice|tea|coffee/.test(name)) return "beverages";
  if (/snack|crisp|chip|biscuit|cookie|nuts/.test(name)) return "snacks";
  if (/sweet|cake|chocolate|dessert/.test(name)) return "sweets";
  if (/fruit|vegetable|produce/.test(name)) return "produce";
  if (/soap|clean|tissue|essential|umbrella/.test(name)) return "essentials";
  return "other";
}

async function hourlyDemand(item) {
  const history = await db.query(
    `SELECT AVG(quantity_sold)::float AS average, COUNT(*)::int AS observations
     FROM hourly_sales
     WHERE store_id = $1 AND sku = $2
       AND hour_start >= NOW() - INTERVAL '28 days'
       AND hour_start < NOW()`,
    [item.storeId, item.sku]
  );
  const observations = history.rows[0].observations;
  return observations >= 3
    ? {
        value: Number(history.rows[0].average),
        quality: `Measured hourly sales average from ${observations} records in the last 28 days`,
      }
    : {
        value: item.hourlyDemand,
        quality: `${item.verificationStatus} baseline hourly demand input; insufficient hourly sales history`,
      };
}

async function activeEvents(item, horizonHours) {
  const result = await db.query(
    `SELECT event_name, event_type, starts_at, ends_at, affected_category,
       expected_demand_uplift_percent, uplift_source, verification_status
     FROM events
     WHERE starts_at < NOW() + ($1 * INTERVAL '1 hour')
       AND ends_at > NOW()
       AND (location IS NULL OR LOWER(location) = LOWER($2))
     ORDER BY starts_at`,
    [horizonHours, item.city || ""]
  );
  return result.rows.filter(
    (event) => event.affected_category.toLowerCase() === categoryFor(item)
  );
}

function projectedForecast(
  item,
  hours,
  scenario,
  demandQuality,
  events,
  scheduledDeliveries = []
) {
  const forecast = [];
  let stock = item.stock;
  let stockoutInHours = null;
  const start = Date.now();
  const selectedEnd = scenario.config
    ? scenario.startHour + scenario.config.durationHours
    : 0;

  for (let hour = 1; hour <= hours; hour += 1) {
    const intervalStart = start + (hour - 1) * 3600000;
    const intervalEnd = start + hour * 3600000;
    const matchingEvents = events.filter(
      (event) =>
        Date.parse(event.starts_at) < intervalEnd &&
        Date.parse(event.ends_at) > intervalStart
    );
    const configuredApplies =
      scenario.config &&
      hour >= scenario.startHour &&
      hour < selectedEnd &&
      scenario.config.categories.includes(categoryFor(item));
    const configuredUplift = configuredApplies
      ? scenario.config.upliftPercent
      : 0;
    const eventUplift = matchingEvents.reduce(
      (highest, event) =>
        Math.max(highest, Number(event.expected_demand_uplift_percent)),
      0
    );
    const upliftPercent = Math.max(configuredUplift, eventUplift);
    const baselineDemand = item.hourlyDemand;
    const forecastDemand = baselineDemand * (1 + upliftPercent / 100);
    const scheduledDelivery = scheduledDeliveries
      .filter(
        (delivery) =>
          delivery.arrivalHour > hour - 1 && delivery.arrivalHour <= hour
      )
      .reduce((sum, delivery) => sum + delivery.quantity, 0);
    stock += scheduledDelivery;
    if (
      stockoutInHours === null &&
      forecastDemand > 0 &&
      stock <= forecastDemand
    ) {
      stockoutInHours =
        hour - 1 + Math.min(1, stock / forecastDemand);
    }
    const unitsSold = Math.min(stock, forecastDemand);
    const estimatedUnfilledDemand = forecastDemand - unitsSold;
    stock = Math.max(0, stock - unitsSold);
    forecast.push({
      hour,
      event:
        matchingEvents.length > 0
          ? matchingEvents.map((event) => event.event_name).join(", ")
          : configuredApplies
            ? scenario.config.label
            : "Baseline",
      baselineDemand,
      upliftPercent,
      forecastDemand,
      scheduledDelivery,
      projectedStock: stock,
      stockoutRisk: stockoutInHours !== null && stockoutInHours <= hour,
      estimatedUnfilledDemand,
    });
  }

  const truckArrivalHour = item.truckArrivalHour;
  const fullHours = Math.floor(truckArrivalHour);
  let demandBeforeTruck = forecast
    .filter((row) => row.hour <= Math.min(fullHours, forecast.length))
    .reduce((sum, row) => sum + row.forecastDemand, 0);
  const fraction = truckArrivalHour - fullHours;
  if (fraction > 0 && fullHours < forecast.length) {
    const nextHour = forecast[fullHours];
    if (nextHour) demandBeforeTruck += nextHour.forecastDemand * fraction;
  }
  const deliveriesBeforeTruck = scheduledDeliveries
    .filter((delivery) => delivery.arrivalHour < truckArrivalHour)
    .reduce((sum, delivery) => sum + delivery.quantity, 0);

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
      dataQuality:
        events.length > 0
          ? `${demandQuality}; event uplift uses ${events.map((event) => event.uplift_source).join(", ")}`
          : scenario.config
            ? `${demandQuality}; ${scenario.config.source}`
            : demandQuality,
    },
    stockoutInHours,
    expectedShortageBeforeTruck: Math.max(
      0,
      Math.ceil(demandBeforeTruck - item.stock - deliveriesBeforeTruck)
    ),
    demandBeforeTruck,
    forecast,
  };
}

async function buildDatabaseForecast(item, hours, scenario) {
  const demand = await hourlyDemand(item);
  const enriched = { ...item, hourlyDemand: demand.value };
  const events = await activeEvents(enriched, Math.max(hours, item.truckArrivalHour));
  const [scheduledTrucks, simulatedDeliveries] = await Promise.all([
    db.query(
      `SELECT GREATEST(0, EXTRACT(EPOCH FROM (t.scheduled_arrival_at - NOW())) / 3600)::float AS arrival_hour,
        td.quantity
       FROM truck_deliveries td JOIN trucks t ON t.truck_id = td.truck_id
       WHERE t.store_id = $1 AND td.sku = $2
         AND t.delivery_status IN ('scheduled', 'in_transit')
         AND t.scheduled_arrival_at >= NOW()
         AND t.scheduled_arrival_at <= NOW() + ($3 * INTERVAL '1 hour')`,
      [item.storeId, item.sku, Math.max(hours, item.truckArrivalHour)]
    ),
    db.query(
      `SELECT arrival_hour, quantity FROM demo_deliveries
       WHERE store_id = $1 AND sku = $2 AND arrival_hour <= $3`,
      [item.storeId, item.sku, Math.max(hours, item.truckArrivalHour)]
    ),
  ]);
  const deliveries = [
    ...scheduledTrucks.rows.map((row) => ({
      arrivalHour: Number(row.arrival_hour),
      quantity: Number(row.quantity),
    })),
    ...simulatedDeliveries.rows.map((row) => ({
      arrivalHour: Number(row.arrival_hour),
      quantity: Number(row.quantity),
    })),
  ];
  return projectedForecast(
    enriched,
    hours,
    scenario,
    demand.quality,
    events,
    deliveries
  );
}

async function transferAssessment(target, scenario, selectedDonorId = null) {
  const targetForecast = await buildDatabaseForecast(
    target,
    Math.max(24, Math.ceil(target.truckArrivalHour)),
    scenario
  );
  const requiredQuantity = targetForecast.expectedShortageBeforeTruck;
  const donors = (await getInventoryRows()).filter(
    (item) =>
      item.storeId !== target.storeId &&
      item.sku === target.sku &&
      (selectedDonorId === null || item.storeId === Number(selectedDonorId))
  );
  const options = [];
  for (const donor of donors) {
    const constraints = [];
    if (!inventoryIsFresh(donor.lastUpdatedAt)) {
      constraints.push("Donor inventory is stale or has no update timestamp (24-hour freshness limit).");
    }
    if (!inventoryIsFresh(target.lastUpdatedAt)) {
      constraints.push("Destination inventory is stale or has no update timestamp (24-hour freshness limit).");
    }
    if (donor.safetyStock === undefined) constraints.push("Donor safety-stock threshold is not configured.");
    if (donor.transferEtaHours === undefined) constraints.push("Transfer delivery time is not configured.");
    if (donor.transportCapacity === undefined) constraints.push("Available transport capacity is not configured.");
    if (target.shelfCapacity === undefined) constraints.push("Destination shelf capacity is unavailable.");
    const distanceKm =
      donor.latitude === null ||
      donor.longitude === null ||
      target.latitude === null ||
      target.longitude === null
        ? undefined
        : haversineKm(
            donor.latitude,
            donor.longitude,
            target.latitude,
            target.longitude
          );
    if (distanceKm === undefined) {
      constraints.push("Donor or destination coordinates are unavailable; proximity cannot be verified.");
    }
    if (donor.truckArrivalHour <= 0) {
      constraints.push("Donor's next scheduled delivery time is unavailable.");
    }
    const donorForecast =
      donor.truckArrivalHour > 0
        ? await buildDatabaseForecast(
            donor,
            Math.max(24, Math.ceil(donor.truckArrivalHour)),
            scenario
          )
        : null;
    const donorInboundBeforeTruck = donorForecast
      ? donorForecast.forecast
          .filter((row) => row.hour < donor.truckArrivalHour)
          .reduce((sum, row) => sum + row.scheduledDelivery, 0)
      : 0;
    const safeDonorSurplus =
      donor.safetyStock === undefined || !donorForecast
        ? undefined
        : Math.max(
            0,
            Math.floor(
              donor.stock +
                donorInboundBeforeTruck -
                donorForecast.demandBeforeTruck -
                donor.safetyStock
            )
          );
    let donorDemandAtTransfer = 0;
    if (donorForecast && donor.transferEtaHours !== undefined) {
      for (const row of donorForecast.forecast) {
        const fraction = Math.max(0, Math.min(1, donor.transferEtaHours - row.hour + 1));
        donorDemandAtTransfer += row.forecastDemand * fraction;
      }
    }
    const donorAvailableAtTransfer =
      donor.transferEtaHours === undefined || !donorForecast
        ? undefined
      : Math.max(0, Math.floor(donor.stock - donorDemandAtTransfer));
    const donorSurplus =
      safeDonorSurplus === undefined || donorAvailableAtTransfer === undefined
        ? undefined
        : Math.min(safeDonorSurplus, donorAvailableAtTransfer);
    const shelfSpace = Math.max(0, target.shelfCapacity - target.stock);
    const knownLimits = [
      requiredQuantity,
      donorSurplus,
      shelfSpace,
      donor.transportCapacity,
    ];
    const known = knownLimits.every(
      (value) => value !== undefined && Number.isFinite(value)
    );
    const quantity = known ? Math.max(0, Math.min(...knownLimits)) : 0;
    if (
      donor.transferEtaHours !== undefined &&
      targetForecast.stockoutInHours !== null &&
      donor.transferEtaHours >= targetForecast.stockoutInHours
    ) {
      constraints.push("Transfer ETA is not earlier than the predicted stockout.");
    }
    if (donorSurplus !== undefined && donorSurplus <= 0) {
      constraints.push("Donor has no stock above safety stock and forecast demand through its next replenishment.");
    }
    if (quantity <= 0 && constraints.length === 0 && requiredQuantity > 0) {
      constraints.push("No positive transfer quantity satisfies all capacity limits.");
    }
    options.push({
      donor,
      distanceKm,
      quantity,
      safeDonorSurplus,
      donorAvailableAtTransfer,
      donorDemandUntilReplenishment: donorForecast?.demandBeforeTruck ?? null,
      constraints,
      feasible: known && quantity > 0 && constraints.length === 0,
    });
  }
  options.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
      a.donor.storeId - b.donor.storeId
  );
  const best = options[0];
  if (!best && requiredQuantity > 0) {
    return {
      feasible: false,
      donor: null,
      quantity: 0,
      requiredQuantity,
      targetForecast,
      constraints: ["No other store with the same SKU is present in inventory."],
    };
  }
  return {
    feasible: best?.feasible === true,
    donor: best?.donor || null,
    quantity: best?.quantity || 0,
    requiredQuantity,
    destinationShelfSpace: Math.max(0, target.shelfCapacity - target.stock),
    distanceKm: best?.distanceKm,
    safeDonorSurplus: best?.safeDonorSurplus,
    donorAvailableAtTransfer: best?.donorAvailableAtTransfer,
    donorDemandUntilReplenishment: best?.donorDemandUntilReplenishment,
    targetForecast,
    constraints: best?.constraints || [],
  };
}

async function actionComparison(target, scenario) {
  const assessment = await transferAssessment(target, scenario);
  const shortage = assessment.requiredQuantity;
  const earlierAvailable = target.earlierTruckAvailable === true;
  const earlierTimingValid =
    target.earlierTruckArrivalHour !== undefined &&
    (assessment.targetForecast.stockoutInHours === null ||
      target.earlierTruckArrivalHour < assessment.targetForecast.stockoutInHours);
  const earlyQuantityValid =
    target.earlierTruckUnits !== undefined &&
    target.earlierTruckUnits >= shortage;
  const transfer = {
    type: "TRANSFER",
    title: "Transfer stock from another store",
    feasible: assessment.feasible,
    quantity: assessment.quantity,
    fromStore: assessment.donor?.storeId ?? null,
    reason: assessment.feasible
    ? `${assessment.donor.storeName} (${assessment.distanceKm.toFixed(2)} km straight-line) can provide ${assessment.quantity} units within configured donor, timing, shelf, and transport constraints.`
      : "A transfer cannot be marked feasible until all required donor and logistics checks pass.",
    constraints: assessment.constraints,
    expectedShortage: Math.max(0, shortage - assessment.quantity),
  };
  const earlierTruck = {
    type: "EARLIER_TRUCK",
    title: "Request an earlier truck",
    feasible: earlierAvailable && earlierTimingValid && earlyQuantityValid,
    quantity: target.earlierTruckUnits ?? 0,
    fromStore: null,
    reason: earlierAvailable
      ? "An earlier truck option is compared against the stockout time and confirmed quantity."
      : "No confirmed earlier-truck availability is recorded.",
    constraints: [
      ...(!earlierAvailable ? ["Dispatch confirmation of earlier arrival is missing."] : []),
      ...(target.earlierTruckArrivalHour === undefined ? ["Earlier arrival time is missing."] : []),
      ...(target.earlierTruckUnits === undefined ? ["Confirmed delivery quantity is missing."] : []),
      ...(!earlierTimingValid ? ["Earlier delivery does not precede the predicted stockout."] : []),
      ...(!earlyQuantityValid ? ["Confirmed quantity does not cover the forecast shortage."] : []),
    ],
    expectedShortage: Math.max(
      0,
      shortage - (earlierAvailable && earlierTimingValid ? target.earlierTruckUnits || 0 : 0)
    ),
  };
  const shelfSwap = {
    type: "SHELF_SWAP",
    title: "Reassign shelf space from a slow seller",
    feasible: false,
    quantity: 0,
    fromStore: null,
    reason: "Shelf space does not add inventory and no verified shelf-slot or replenishment data is recorded.",
    constraints: [
      "Shelf-slot assignment and product dimensions are not configured.",
      "No associated stock replenishment is confirmed.",
    ],
    expectedShortage: shortage,
  };
  const wait = {
    type: "WAIT",
    title: "Wait for the scheduled truck",
    feasible: true,
    quantity: 0,
    fromStore: null,
    reason: `Baseline comparison: the scheduled truck is in ${target.truckArrivalHour} hours.`,
    constraints: ["No delivery changes or action costs are assumed."],
    expectedShortage: shortage,
  };
  const withFinancials = (option) => ({
    ...option,
    lostSalesRevenue:
      target.unitPrice === undefined
        ? null
        : option.expectedShortage * target.unitPrice,
    lostGrossMargin:
      target.unitMargin === undefined
        ? null
        : option.expectedShortage * target.unitMargin,
    actionCost: null,
  });
  const evaluated = [transfer, earlierTruck, shelfSwap, wait].map(withFinancials);
  const preferredOption =
    evaluated.find((option) => option.type === "TRANSFER" && option.feasible) ||
    evaluated.find((option) => option.type === "EARLIER_TRUCK" && option.feasible) ||
    null;
  return {
    storeId: target.storeId,
    sku: target.sku,
    scenario: scenario.key,
    baselineShortage: shortage,
    preferredOption: preferredOption?.type ?? null,
    options: evaluated,
    reasoning: [
      { step: "Observe inventory and delivery schedule", status: "passed", detail: `${target.stock} units on hand; scheduled arrival in ${target.truckArrivalHour} hours.` },
      { step: "Forecast hourly demand", status: "passed", detail: assessment.targetForecast.scenario.dataQuality },
      { step: "Detect possible stockout", status: shortage > 0 ? "passed" : "passed", detail: `${shortage} unmet units forecast before the next truck.` },
      { step: "Find nearby potential donor stores", status: assessment.donor ? "passed" : "missing", detail: assessment.donor ? `Same-SKU donor candidate: ${assessment.donor.storeName}.` : "No same-SKU donor inventory record is available." },
      { step: "Validate safety stock, shelf capacity and logistics", status: assessment.feasible ? "passed" : "needs_verification", detail: assessment.constraints.join(" ") || "All recorded transfer constraints pass." },
      { step: "Compare transfer, earlier truck, waiting and shelf swap", status: "passed", detail: preferredOption ? `${preferredOption.title} is the best supported intervention.` : "Waiting is the baseline; no alternative is fully verified." },
      { step: "Request manager approval", status: preferredOption ? "pending" : "needs_verification", detail: preferredOption ? "A simulated action requires manager approval." : "Manager intervention is required to resolve missing or failed data." },
    ],
  };
}

function actionRecord(row) {
  return {
    id: String(row.action_id),
    status: row.status,
    action: row.action_type,
    feasible: row.feasible,
    fromStore: row.source_store_id == null ? null : Number(row.source_store_id),
    toStore: Number(row.destination_store_id),
    storeId: Number(row.destination_store_id),
    quantity: row.quantity,
    requiredQuantity: row.required_quantity,
    sku: row.sku,
    product: row.product_name,
    constraints: row.constraints,
    scenario: row.scenario,
    estimatedUnfilledUnitsAfterAction: row.estimated_unfilled_units_after_action,
    reason: row.explanation,
    processedAt: row.approval_at || row.rejection_at || undefined,
    completedAt: row.completed_at || undefined,
    estimatedImpact: row.estimated_impact,
  };
}

async function getAction(id, client = db) {
  const result = await client.query(
    `SELECT a.*, p.product_name FROM actions a
     JOIN products p ON p.sku = a.sku WHERE a.action_id = $1`,
    [id]
  );
  return result.rows[0] ? actionRecord(result.rows[0]) : null;
}

async function revalidateTransferAction(client, action) {
  if (action.action !== "TRANSFER" || !action.feasible || !action.fromStore) {
    const conflict = new Error("This recommendation is unverified or infeasible.");
    conflict.status = 409;
    throw conflict;
  }
  const ids = [action.fromStore, action.toStore].sort((a, b) => a - b);
  const locked = await client.query(
    `SELECT store_id, sku FROM inventory
     WHERE sku = $1 AND store_id = ANY($2::bigint[])
     ORDER BY store_id FOR UPDATE`,
    [action.sku, ids]
  );
  if (locked.rowCount !== 2) {
    const conflict = new Error("Source or destination inventory is missing.");
    conflict.status = 409;
    throw conflict;
  }
  const records = await getInventoryRows(client);
  const donor = records.find((item) => item.storeId === action.fromStore && item.sku === action.sku);
  const target = records.find((item) => item.storeId === action.toStore && item.sku === action.sku);
  if (
    !donor ||
    !target ||
    !inventoryIsFresh(donor.lastUpdatedAt) ||
    !inventoryIsFresh(target.lastUpdatedAt) ||
    donor.latitude === null ||
    donor.longitude === null ||
    target.latitude === null ||
    target.longitude === null ||
    donor.truckArrivalHour <= 0
  ) {
    const conflict = new Error("Current locations, inventory freshness, or donor replenishment timing are unverified.");
    conflict.status = 409;
    throw conflict;
  }
  const scenario = parseScenario({ scenario: action.scenario }, scenarioConfig);
  if (!scenario) {
    const conflict = new Error("The action scenario is invalid.");
    conflict.status = 409;
    throw conflict;
  }
  const assessment = await transferAssessment(target, scenario, donor.storeId);
  if (
    !assessment.feasible ||
    assessment.donor?.storeId !== donor.storeId ||
    action.quantity <= 0 ||
    assessment.quantity < action.quantity ||
    target.stock + action.quantity > target.shelfCapacity
  ) {
    const conflict = new Error("Transfer feasibility changed; inventory was not modified.");
    conflict.status = 409;
    conflict.constraints = assessment.constraints;
    throw conflict;
  }
  return { donor, target, assessment };
}

function validateInventory(body) {
  const required = ["storeId", "sku", "product", "stock", "hourlyDemand", "shelfCapacity", "truckArrivalHour"];
  if (!body || required.some((key) => body[key] === undefined)) return "All inventory fields are required.";
  if (!Number.isInteger(Number(body.storeId)) || Number(body.storeId) <= 0 || typeof body.sku !== "string" || !body.sku.trim() || typeof body.product !== "string" || !body.product.trim()) {
    return "Store ID, SKU, and product must be valid.";
  }
  for (const key of ["stock", "hourlyDemand", "shelfCapacity", "truckArrivalHour"]) {
    if (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0) return `${key} must be a non-negative number.`;
  }
  if (!Number.isInteger(Number(body.stock)) || !Number.isInteger(Number(body.shelfCapacity))) {
    return "Stock and shelf capacity must be whole units.";
  }
  if (Number(body.stock) > Number(body.shelfCapacity)) return "Shelf capacity must be at least current stock.";
  for (const key of ["safetyStock", "unitPrice", "unitCost", "transferEtaHours", "transportCapacity", "earlierTruckArrivalHour", "earlierTruckUnits"]) {
    if (body[key] !== undefined && body[key] !== null && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0)) {
      return `${key} must be a non-negative number.`;
    }
  }
  for (const key of ["safetyStock", "transportCapacity", "earlierTruckUnits"]) {
    if (body[key] !== undefined && body[key] !== null && !Number.isInteger(Number(body[key]))) {
      return `${key} must be a whole number.`;
    }
  }
  if (body.safetyStock !== undefined && body.safetyStock !== null && Number(body.safetyStock) > Number(body.stock)) {
    return "Safety stock cannot exceed current stock.";
  }
  return null;
}

async function handle(req, res, scenarioConfig) {
  if (!db.enabled) return false;
  const { method, path: pathname } = req;
  if (method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
    const result = await db.query(
      "SELECT NOW() AS database_time, to_regclass('public.inventory') AS inventory_table"
    );
    if (!result.rows[0].inventory_table) {
      res.status(503).json({
        status: "ERROR",
        storage: "postgresql",
        error: "Database migrations have not been applied.",
      });
      return true;
    }
    res.json({ status: "OK", storage: "postgresql", databaseTime: result.rows[0].database_time });
    return true;
  }
  if (method === "GET" && pathname === "/api/inventory") {
    const inventory = await getInventoryRows();
    res.json(inventory.map((item) => ({
      ...item,
      source: item.verificationStatus === "verified" ? "backend" : "backend",
    })));
    return true;
  }
  if (method === "POST" && pathname === "/api/inventory") {
    const error = validateInventory(req.body);
    if (error) {
      res.status(400).json({ error });
      return true;
    }
    const inventoryMatch = pathname.match(/^\/api\/inventory\/(\d+)\/([^/]+)$/);
    if (method === "PUT" && inventoryMatch) {
      const storeId = Number(inventoryMatch[1]);
      const sku = decodeURIComponent(inventoryMatch[2]);
      const body = req.body || {};
      if (
        !Number.isInteger(body.stock) ||
        body.stock < 0 ||
        !Number.isFinite(body.hourlyDemand) ||
        body.hourlyDemand < 0 ||
        !Number.isInteger(body.shelfCapacity) ||
        body.shelfCapacity < body.stock
      ) {
        res.status(400).json({
          error: "Provide whole non-negative stock and shelf capacity, and non-negative hourly demand; capacity must cover stock.",
        });
        return true;
      }
      const updated = await db.transaction(async (client) => {
        const current = await client.query(
          `SELECT current_stock FROM inventory
           WHERE store_id = $1 AND sku = $2 FOR UPDATE`,
          [storeId, sku]
        );
        if (!current.rowCount) {
          const notFound = new Error("Product not found in this store.");
          notFound.status = 404;
          throw notFound;
        }
        const safetyStock =
          body.safetyStock === undefined ? null : Number(body.safetyStock);
        if (
          safetyStock !== null &&
          (!Number.isInteger(safetyStock) ||
            safetyStock < 0 ||
            safetyStock > body.stock)
        ) {
          const badRequest = new Error("Safety stock must be a whole number within current stock.");
          badRequest.status = 400;
          throw badRequest;
        }
        const result = await client.query(
          `UPDATE inventory SET current_stock = $3, baseline_hourly_demand = $4,
            shelf_capacity = $5,
            safety_stock = COALESCE($6, safety_stock),
            inventory_source = 'simulated API inventory update',
            verification_status = 'simulated', last_updated_at = NOW()
           WHERE store_id = $1 AND sku = $2`,
          [storeId, sku, body.stock, body.hourlyDemand, body.shelfCapacity, safetyStock]
        );
        return findInventory(storeId, sku, client);
      });
      res.json(updated);
      return true;
    }
    const body = req.body;
    const result = await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO stores (store_id, name, store_type, verification_status)
         VALUES ($1, $2, 'simulated operational location', 'simulated')
         ON CONFLICT (store_id) DO NOTHING`,
        [Number(body.storeId), body.storeName?.trim() || `Store ${body.storeId}`]
      );
      await client.query(
        `INSERT INTO products (sku, product_name, category, selling_price, unit_cost)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sku) DO NOTHING`,
        [
          body.sku.trim(),
          body.product.trim(),
          body.category || categoryFor({ product: body.product.trim() }),
          body.unitPrice ?? null,
          body.unitCost ?? null,
        ]
      );
      const insert = await client.query(
        `INSERT INTO inventory (
          store_id, sku, current_stock, safety_stock, shelf_capacity,
          baseline_hourly_demand, transfer_eta_hours, transport_capacity,
          earlier_truck_available, earlier_truck_arrival_hour, earlier_truck_units,
          shelf_space_shareable, inventory_source, verification_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'frontend simulated entry','simulated')
        ON CONFLICT (store_id, sku) DO NOTHING RETURNING store_id`,
        [
          Number(body.storeId), body.sku.trim(), Number(body.stock), body.safetyStock ?? null,
          Number(body.shelfCapacity), Number(body.hourlyDemand), body.transferEtaHours ?? null,
          body.transportCapacity ?? null, body.earlierTruckAvailable ?? null,
          body.earlierTruckArrivalHour ?? null, body.earlierTruckUnits ?? null,
          body.shelfSpaceShareable ?? null,
        ]
      );
      if (!insert.rowCount) {
        const duplicate = new Error("This SKU already exists at this store.");
        duplicate.status = 409;
        throw duplicate;
      }
      await client.query(
        `INSERT INTO trucks (truck_id, store_id, scheduled_arrival_at, data_source, delivery_status)
         VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 hour'),'frontend simulated entry','scheduled')
         ON CONFLICT DO NOTHING`,
        [`sim-${body.storeId}-${body.sku}`, Number(body.storeId), Number(body.truckArrivalHour)]
      );
      return findInventory(body.storeId, body.sku, client);
    });
    res.status(201).json(result);
    return true;
  }
  if (method === "GET" && pathname === "/api/stores") {
    const result = await db.query(
      `SELECT store_id AS "storeId", name, address, locality, city, state,
        postal_code AS "postalCode", latitude, longitude,
        geographic_source_id AS "geographicSourceId", location_source AS "locationSource",
        geography_retrieved_at AS "geographyRetrievedAt",
        store_type AS "storeType", verification_status AS "verificationStatus",
        active, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM stores WHERE active = TRUE ORDER BY city NULLS LAST, name`
    );
    res.json({ stores: result.rows, attribution: "© OpenStreetMap contributors" });
    return true;
  }
  if (method === "POST" && pathname === "/api/stores") {
    const body = req.body || {};
    const areaExists = bengaluruAreas.some((area) => area.name === body.locality);
    if (
      !Number.isInteger(Number(body.storeId)) ||
      Number(body.storeId) <= 0 ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      !areaExists ||
      ((body.latitude !== undefined || body.longitude !== undefined) &&
        !validCoordinate(Number(body.latitude), Number(body.longitude))) ||
      (body.latitude !== undefined &&
        (typeof body.locationSource !== "string" || !body.locationSource.trim() ||
          body.verificationStatus === "verified"))
    ) {
      res.status(400).json({
        error: "Provide a positive store ID, name, configured Bengaluru area, and valid coordinates with a source label; demo stores cannot be marked verified.",
      });
      return true;
    }
    const store = await db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO stores (
          store_id, name, address, locality, city, state, latitude, longitude,
          location_source, store_type, verification_status, active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'simulated operational location','simulated',$10)
        RETURNING store_id AS "storeId", name, address, locality, city, state,
          latitude, longitude, location_source AS "locationSource",
          store_type AS "storeType", verification_status AS "verificationStatus", active`,
        [
          Number(body.storeId),
          body.name.trim(),
          body.address?.trim() || null,
          body.locality,
          body.city?.trim() || "Bengaluru",
          body.state?.trim() || "Karnataka",
          body.latitude ?? null,
          body.longitude ?? null,
          body.locationSource?.trim() || "coordinates unavailable",
          body.active !== false,
        ]
      );
      return result.rows[0];
    });
    res.status(201).json(store);
    return true;
  }
  const editStoreMatch = pathname.match(/^\/api\/stores\/(\d+)$/);
  if (method === "PUT" && editStoreMatch) {
    const body = req.body || {};
    const storeId = Number(editStoreMatch[1]);
    const areaExists = bengaluruAreas.some((area) => area.name === body.locality);
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      !areaExists ||
      ((body.latitude !== undefined || body.longitude !== undefined) &&
        !validCoordinate(Number(body.latitude), Number(body.longitude))) ||
      (body.latitude !== undefined &&
        (typeof body.locationSource !== "string" || !body.locationSource.trim() ||
          body.verificationStatus === "verified"))
    ) {
      res.status(400).json({
        error: "Provide a store name, configured Bengaluru area, and valid coordinates with a source label; demo stores cannot be marked verified.",
      });
      return true;
    }
    const result = await db.query(
      `UPDATE stores SET name = $2, address = $3, locality = $4,
        city = $5, state = $6,
        latitude = CASE WHEN $7 THEN $8 ELSE latitude END,
        longitude = CASE WHEN $7 THEN $9 ELSE longitude END,
        location_source = CASE WHEN $7 THEN $10 ELSE location_source END,
        active = $11, updated_at = NOW()
       WHERE store_id = $1
       RETURNING store_id AS "storeId", name, address, locality, city, state,
         latitude, longitude, location_source AS "locationSource",
         store_type AS "storeType", verification_status AS "verificationStatus", active`,
      [
        storeId,
        body.name.trim(),
        body.address?.trim() || null,
        body.locality,
        body.city?.trim() || "Bengaluru",
        body.state?.trim() || "Karnataka",
        body.latitude !== undefined || body.longitude !== undefined,
        body.latitude ?? null,
        body.longitude ?? null,
        body.locationSource?.trim() || "coordinates unavailable",
        body.active !== false,
      ]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Store not found." });
      return true;
    }
    res.json(result.rows[0]);
    return true;
  }
  if (method === "GET" && pathname === "/api/stores/nearby") {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    const radiusKm = req.query.radiusKm === undefined ? 5 : Number(req.query.radiusKm);
    if (!validCoordinate(latitude, longitude) || !Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 100) {
      res.status(400).json({ error: "Provide valid latitude, longitude, and radiusKm (0-100)." });
      return true;
    }
    const stores = await db.query(
      `SELECT s.store_id AS "storeId", s.name, s.address, s.locality, s.city, s.state,
        s.postal_code AS "postalCode", s.latitude, s.longitude,
        s.geographic_source_id AS "geographicSourceId", s.location_source AS "locationSource",
        s.geography_retrieved_at AS "geographyRetrievedAt",
        s.store_type AS "storeType", s.verification_status AS "verificationStatus",
        EXISTS (SELECT 1 FROM inventory i WHERE i.store_id = s.store_id) AS "inventoryAvailable"
       FROM stores s
       WHERE s.active = TRUE AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL`
    );
    const nearby = stores.rows
      .map((store) => ({
        ...store,
        distanceKm: haversineKm(latitude, longitude, Number(store.latitude), Number(store.longitude)),
        inventoryAvailable: store.inventoryAvailable,
      }))
      .filter((store) => store.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    res.json({ stores: nearby, radiusKm, distanceType: "straight-line haversine distance", inventoryNote: "Geographic retail locations do not imply Zipcart ownership or inventory availability." });
    return true;
  }
  if (method === "GET" && pathname === "/api/bengaluru-areas") {
    res.json({
      areas: bengaluruAreas.map((area) => area.name),
      source: "configured Bengaluru area list",
    });
    return true;
  }
  if (method === "GET" && pathname === "/api/stock-rescue") {
    const storeId = Number(req.query.storeId);
    const sku = typeof req.query.sku === "string" ? req.query.sku.trim() : "";
    const radiusKm = req.query.radiusKm === undefined ? 10 : Number(req.query.radiusKm);
    const scenario = parseScenario({ ...req.query, scenario: req.query.scenario || "baseline" }, scenarioConfig);
    if (
      !Number.isInteger(storeId) ||
      storeId <= 0 ||
      !sku ||
      !Number.isFinite(radiusKm) ||
      radiusKm <= 0 ||
      radiusKm > 100 ||
      !scenario
    ) {
      res.status(400).json({
        error: "Provide a valid storeId, SKU, scenario, and radiusKm between 0 and 100.",
      });
      return true;
    }
    const target = await findInventory(storeId, sku);
    if (!target) {
      res.status(404).json({ error: "Selected store does not carry this SKU." });
      return true;
    }
    const [stores, inventory] = await Promise.all([
      db.query(
        `SELECT store_id AS "storeId", name, locality, location_source AS "locationSource",
          verification_status AS "verificationStatus"
         FROM stores WHERE active = TRUE`
      ),
      getInventoryRows(),
    ]);
    const targetStore = stores.rows.find((store) => Number(store.storeId) === storeId);
    const targetForecast = await buildDatabaseForecast(
      target,
      Math.max(24, Math.ceil(target.truckArrivalHour)),
      scenario
    );
    const candidates = [];
    for (const donor of inventory.filter((item) => item.storeId !== storeId && item.sku === sku)) {
      const donorStore = stores.rows.find((store) => Number(store.storeId) === donor.storeId);
      const assessment = await transferAssessment(target, scenario, donor.storeId);
      const distanceKm = assessment.donor?.storeId === donor.storeId ? assessment.distanceKm : undefined;
      if (distanceKm !== undefined && distanceKm > radiusKm) continue;
      candidates.push({
        storeId: donor.storeId,
        name: donor.storeName || `Store ${donor.storeId}`,
        area: donorStore?.locality || null,
        stock: donor.stock,
        hourlyDemand: donor.hourlyDemand,
        safetyStock: donor.safetyStock ?? null,
        shelfCapacity: donor.shelfCapacity,
        truckArrivalHour: donor.truckArrivalHour,
        distanceKm: distanceKm ?? null,
        distanceSource: distanceKm === undefined ? "unavailable" : "straight-line Haversine",
        locationSource: donor.locationSource || donorStore?.locationSource || null,
        safeTransferableSurplus: assessment.safeDonorSurplus ?? null,
        stockAvailableAtTransfer: assessment.donorAvailableAtTransfer ?? null,
        donorDemandUntilReplenishment: assessment.donorDemandUntilReplenishment ?? null,
        transferEtaHours: donor.transferEtaHours ?? null,
        estimatedTransferQuantity: assessment.quantity,
        feasible: assessment.feasible,
        constraints: assessment.constraints,
        inventorySource: donor.inventorySource,
        verificationStatus: donor.verificationStatus,
      });
    }
    candidates.sort(
      (left, right) =>
        Number(right.feasible) - Number(left.feasible) ||
        (left.distanceKm ?? Infinity) - (right.distanceKm ?? Infinity) ||
        left.storeId - right.storeId
    );
    res.json({
      target: {
        storeId,
        name: targetStore?.name || `Store ${storeId}`,
        area: targetStore?.locality || null,
        sku,
        product: target.product,
        currentStock: target.stock,
        hourlyDemand: target.hourlyDemand,
        truckArrivalHour: target.truckArrivalHour,
        stockoutInHours: targetForecast.stockoutInHours,
        expectedShortageBeforeTruck: targetForecast.expectedShortageBeforeTruck,
        shelfCapacity: target.shelfCapacity,
        dataQuality: targetForecast.scenario.dataQuality,
      },
      candidates,
      radiusKm,
      proximityVerified:
        candidates.length > 0 &&
        candidates.every((candidate) => candidate.distanceKm !== null),
      distanceType: "straight-line Haversine; not a route or travel-time estimate",
    });
    return true;
  }
  const storeDetailsMatch = pathname.match(/^\/api\/stores\/(\d+)$/);
  if (method === "GET" && storeDetailsMatch) {
    const storeId = Number(storeDetailsMatch[1]);
    const store = await db.query(
      `SELECT store_id AS "storeId", name, address, locality, city, state,
        postal_code AS "postalCode", latitude, longitude,
        geographic_source_id AS "geographicSourceId", location_source AS "locationSource",
        geography_retrieved_at AS "geographyRetrievedAt",
        store_type AS "storeType", verification_status AS "verificationStatus"
       FROM stores WHERE store_id = $1 AND active = TRUE`,
      [storeId]
    );
    if (!store.rowCount) {
      res.status(404).json({ error: "Store not found." });
      return true;
    }
    const records = (await getInventoryRows()).filter((item) => item.storeId === storeId);
    res.json({ ...store.rows[0], inventory: records });
    return true;
  }
  if (method === "GET" && pathname === "/api/scenarios") {
    const events = await db.query(
      `SELECT event_id AS "eventId", event_name AS "eventName", event_type AS "eventType",
        location, starts_at AS "startsAt", ends_at AS "endsAt",
        affected_category AS "affectedCategory",
        expected_demand_uplift_percent AS "upliftPercent", uplift_source AS "upliftSource",
        verification_status AS "verificationStatus"
       FROM events WHERE ends_at > NOW() ORDER BY starts_at`
    );
    res.json({
      baseline: { label: "Baseline hourly demand", upliftPercent: 0 },
      ...Object.fromEntries(Object.entries(scenarioConfig).map(([key, value]) => [key, { ...value }])),
      events: events.rows,
    });
    return true;
  }
  if (method === "GET" && pathname === "/api/events") {
    const result = await db.query("SELECT * FROM events ORDER BY starts_at DESC LIMIT 500");
    res.json(result.rows);
    return true;
  }
  if (method === "POST" && pathname === "/api/events") {
    const body = req.body || {};
    const uplift = Number(body.expectedDemandUpliftPercent);
    const startsAt = Date.parse(body.startsAt);
    const endsAt = Date.parse(body.endsAt);
    if (!body.eventName || !body.eventType || !body.affectedCategory || !body.upliftSource || !Number.isFinite(uplift) || uplift < 0 || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      res.status(400).json({ error: "Provide event name/type/category/source, a non-negative uplift, and a valid start/end interval." });
      return true;
    }
    if (body.latitude != null || body.longitude != null) {
      if (!validCoordinate(Number(body.latitude), Number(body.longitude))) {
        res.status(400).json({ error: "Event latitude and longitude must be a valid coordinate pair." });
        return true;
      }
    }
    const result = await db.query(
      `INSERT INTO events (event_name,event_type,location,latitude,longitude,starts_at,ends_at,affected_category,expected_demand_uplift_percent,uplift_source,verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [body.eventName,body.eventType,body.location || null,body.latitude ?? null,body.longitude ?? null,body.startsAt,body.endsAt,body.affectedCategory, uplift,body.upliftSource,body.verificationStatus === "verified" ? "verified" : "unverified"]
    );
    res.status(201).json(result.rows[0]);
    return true;
  }
  if (method === "GET" && pathname === "/api/hourly-sales") {
    const storeId = Number(req.query.storeId);
    const sku = req.query.sku;
    if (!Number.isInteger(storeId) || storeId <= 0 || typeof sku !== "string" || !sku) {
      res.status(400).json({ error: "storeId and sku are required to query hourly sales." });
      return true;
    }
    const result = await db.query(
      `SELECT record_id AS "recordId", store_id AS "storeId", sku, hour_start AS "hourStart",
        quantity_sold AS "quantitySold", data_source AS "dataSource", created_at AS "createdAt"
       FROM hourly_sales WHERE store_id = $1 AND sku = $2
       ORDER BY hour_start DESC LIMIT 1000`,
      [storeId, sku]
    );
    res.json(result.rows);
    return true;
  }
  if (method === "POST" && pathname === "/api/hourly-sales") {
    const body = req.body || {};
    if (!Number.isInteger(Number(body.storeId)) || typeof body.sku !== "string" || !body.sku || !Number.isInteger(body.quantitySold) || body.quantitySold < 0 || !Number.isFinite(Date.parse(body.hourStart)) || typeof body.dataSource !== "string" || !body.dataSource.trim()) {
      res.status(400).json({ error: "Provide storeId, sku, hourStart, non-negative integer quantitySold, and dataSource." });
      return true;
    }
    const result = await db.query(
      `INSERT INTO hourly_sales (store_id,sku,hour_start,quantity_sold,data_source)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (store_id,sku,hour_start,data_source)
       DO UPDATE SET quantity_sold = EXCLUDED.quantity_sold
       RETURNING *`,
      [Number(body.storeId), body.sku, body.hourStart, body.quantitySold, body.dataSource]
    );
    res.status(201).json(result.rows[0]);
    return true;
  }
  if (method === "GET" && inventoryMatch) {
    const item = await findInventory(inventoryMatch[1], decodeURIComponent(inventoryMatch[2]));
    if (!item) {
      res.status(404).json({ error: "Product not found in this store." });
      return true;
    }
    res.json(item);
    return true;
  }
  const forecastMatch = pathname.match(/^\/api\/forecast\/(\d+)\/([^/]+)$/);
  if (method === "GET" && forecastMatch) {
    const item = await findInventory(forecastMatch[1], decodeURIComponent(forecastMatch[2]));
    if (!item) {
      res.status(404).json({ error: "Product not found." });
      return true;
    }
    const hours = Number(req.query.hours || 4);
    const scenario = parseScenario(req.query, scenarioConfig);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 || !scenario) {
      res.status(400).json({ error: "Hours must be 1-24 and scenario must be baseline, cricket, festival, or rain." });
      return true;
    }
    res.json(await buildDatabaseForecast(item, hours, scenario));
    return true;
  }
  const comparisonMatch = pathname.match(
    /^\/api\/action-comparison\/(\d+)\/([^/]+)$/
  );
  if (method === "GET" && comparisonMatch) {
    const target = await findInventory(
      comparisonMatch[1],
      decodeURIComponent(comparisonMatch[2])
    );
    if (!target) {
      res.status(404).json({ error: "Product not found." });
      return true;
    }
    const scenario = parseScenario(req.query, scenarioConfig);
    if (!scenario) {
      res.status(400).json({ error: "Scenario must be baseline, cricket, festival, or rain." });
      return true;
    }
    res.json(await actionComparison(target, scenario));
    return true;
  }
  const recommendationMatch = pathname.match(/^\/api\/recommendations\/(\d+)\/([^/]+)$/);
  if (method === "GET" && recommendationMatch) {
    const target = await findInventory(recommendationMatch[1], decodeURIComponent(recommendationMatch[2]));
    if (!target) {
      res.status(404).json({ error: "Target product not found." });
      return true;
    }
    const scenario = parseScenario(req.query, scenarioConfig);
    if (!scenario) {
      res.status(400).json({ error: "Scenario must be baseline, cricket, festival, or rain." });
      return true;
    }
    const assessment = await transferAssessment(target, scenario);
    if (assessment.requiredQuantity <= 0) {
      res.json({
        storeId: target.storeId,
        sku: target.sku,
        predictedStockoutHour: assessment.targetForecast.stockoutInHours,
        recommendation: { action: "WAIT", feasible: true, quantity: 0, reason: "Current stock covers demand until the next scheduled truck.", constraints: [] },
        requiresApproval: false,
        actionRecord: null,
      });
      return true;
    }
    const action = await db.transaction(async (client) => {
      let found = await client.query(
        `SELECT a.*, p.product_name FROM actions a
         JOIN products p ON p.sku = a.sku
         WHERE destination_store_id = $1 AND sku = $2 AND scenario = $3 AND status = 'PENDING'
         ORDER BY action_id DESC LIMIT 1 FOR UPDATE`,
        [target.storeId, target.sku, scenario.key]
      );
      if (found.rowCount) return actionRecord(found.rows[0]);
      const record = await client.query(
        `INSERT INTO actions (
           action_type, sku, quantity, source_store_id, destination_store_id,
           status, feasible, required_quantity, estimated_unfilled_units_after_action,
           explanation, constraints, scenario
         ) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$9,$10::jsonb,$11)
         ON CONFLICT DO NOTHING RETURNING action_id`,
        [
          assessment.feasible ? "TRANSFER" : "REVIEW",
          target.sku,
          assessment.quantity,
          assessment.donor?.storeId ?? null,
          target.storeId,
          assessment.feasible,
          assessment.requiredQuantity,
          Math.max(0, assessment.requiredQuantity - assessment.quantity),
          assessment.feasible
            ? `${assessment.donor.storeName} can provide ${assessment.quantity} units after configured constraints.`
            : "A stockout risk exists, but transfer feasibility is unverified or constrained.",
          JSON.stringify(assessment.constraints),
          scenario.key,
        ]
      );
      if (!record.rowCount) {
        found = await client.query(
          `SELECT a.*, p.product_name FROM actions a JOIN products p ON p.sku = a.sku
           WHERE destination_store_id = $1 AND sku = $2 AND scenario = $3 AND status = 'PENDING'
           ORDER BY action_id DESC LIMIT 1`,
          [target.storeId, target.sku, scenario.key]
        );
        return actionRecord(found.rows[0]);
      }
      await client.query(
        `INSERT INTO action_history (action_id, from_status, to_status, details)
         VALUES ($1, NULL, 'PENDING', $2::jsonb)`,
        [record.rows[0].action_id, JSON.stringify({ source: "deterministic recommendation" })]
      );
      return getAction(record.rows[0].action_id, client);
    });
    res.json({
      storeId: target.storeId,
      sku: target.sku,
      predictedStockoutHour: assessment.targetForecast.stockoutInHours,
      recommendation: action,
      requiresApproval: true,
      actionRecord: action,
    });
    return true;
  }
  if (method === "POST" && pathname === "/api/transfers/proposals") {
    const body = req.body || {};
    const storeId = Number(body.storeId);
    const donorStoreId = Number(body.donorStoreId);
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    const scenario = parseScenario(
      { scenario: body.scenario || "baseline" },
      scenarioConfig
    );
    if (
      !Number.isInteger(storeId) ||
      storeId <= 0 ||
      !Number.isInteger(donorStoreId) ||
      donorStoreId <= 0 ||
      !sku ||
      !scenario
    ) {
      res.status(400).json({
        error: "Provide a valid destination store, donor store, SKU, and scenario.",
      });
      return true;
    }
    const target = await findInventory(storeId, sku);
    if (!target) {
      res.status(404).json({ error: "Destination store does not carry this SKU." });
      return true;
    }
    const assessment = await transferAssessment(target, scenario, donorStoreId);
    if (assessment.requiredQuantity <= 0 || !assessment.feasible) {
      res.status(409).json({
        error: "This transfer cannot be proposed as feasible with the current inputs.",
        requiredQuantity: assessment.requiredQuantity,
        constraints: assessment.constraints,
      });
      return true;
    }
    const result = await db.transaction(async (client) => {
      const existing = await client.query(
        `SELECT a.*, p.product_name FROM actions a
         JOIN products p ON p.sku = a.sku
         WHERE destination_store_id = $1 AND sku = $2 AND scenario = $3
           AND status = 'PENDING' FOR UPDATE OF a`,
        [storeId, sku, scenario.key]
      );
      if (existing.rowCount) {
        const action = actionRecord(existing.rows[0]);
        if (action.action === "TRANSFER" && action.fromStore === donorStoreId) {
          return { action, created: false };
        }
        const conflict = new Error("Another action for this product and scenario is already pending approval.");
        conflict.status = 409;
        throw conflict;
      }
      const inserted = await client.query(
        `INSERT INTO actions (
          action_type, sku, quantity, source_store_id, destination_store_id,
          status, feasible, required_quantity, estimated_unfilled_units_after_action,
          explanation, constraints, scenario
        ) VALUES ('TRANSFER',$1,$2,$3,$4,'PENDING',TRUE,$5,$6,$7,'[]'::jsonb,$8)
        RETURNING action_id`,
        [
          sku,
          assessment.quantity,
          donorStoreId,
          storeId,
          assessment.requiredQuantity,
          Math.max(0, assessment.requiredQuantity - assessment.quantity),
          `Store ${assessment.donor.storeName} has ${assessment.safeDonorSurplus} units of calculated safe surplus; the proposal is capped by demand, shelf space, and transport capacity.`,
          scenario.key,
        ]
      );
      await client.query(
        `INSERT INTO action_history (action_id, from_status, to_status, details)
         VALUES ($1, NULL, 'PENDING', $2::jsonb)`,
        [inserted.rows[0].action_id, JSON.stringify({ source: "simulated stock rescue proposal" })]
      );
      return { action: await getAction(inserted.rows[0].action_id, client), created: true };
    });
    res.status(result.created ? 201 : 200).json({
      message: result.created
        ? "Simulated transfer plan created; manager approval is required and no inventory was moved."
        : "A matching transfer request is already pending manager approval.",
      action: result.action,
    });
    return true;
  }
  if (method === "GET" && pathname === "/api/actions") {
    const result = await db.query(
      `SELECT a.*, p.product_name FROM actions a JOIN products p ON p.sku = a.sku
       ORDER BY a.created_at DESC, a.action_id DESC`
    );
    res.json(result.rows.map(actionRecord));
    return true;
  }
  const actionHistoryMatch = pathname.match(/^\/api\/actions\/(\d+)\/history$/);
  if (method === "GET" && actionHistoryMatch) {
    const result = await db.query(
      `SELECT history_id AS "historyId", action_id AS "actionId",
        from_status AS "fromStatus", to_status AS "toStatus",
        details, occurred_at AS "occurredAt"
       FROM action_history WHERE action_id = $1 ORDER BY occurred_at, history_id`,
      [actionHistoryMatch[1]]
    );
    res.json(result.rows);
    return true;
  }
  const actionMatch = pathname.match(/^\/api\/actions\/(\d+)$/);
  if (method === "POST" && actionMatch) {
    const status = String(req.body?.status || "").toUpperCase();
    if (!["APPROVED", "REJECTED"].includes(status)) {
      res.status(400).json({ error: "Status must be APPROVED or REJECTED." });
      return true;
    }
    const result = await db.transaction(async (client) => {
      const locked = await client.query(
        `SELECT a.*, p.product_name FROM actions a JOIN products p ON p.sku = a.sku
         WHERE action_id = $1 FOR UPDATE OF a`,
        [actionMatch[1]]
      );
      if (!locked.rowCount) {
        const notFound = new Error("Action not found.");
        notFound.status = 404;
        throw notFound;
      }
      const action = actionRecord(locked.rows[0]);
      if (action.status !== "PENDING") {
        const conflict = new Error("This action has already been processed.");
        conflict.status = 409;
        throw conflict;
      }
      if (status === "APPROVED") {
        await revalidateTransferAction(client, action);
      }
      const previousStatus = action.status;
      await client.query(
        `UPDATE actions SET status = $2, approval_at = CASE WHEN $2 = 'APPROVED' THEN NOW() END,
           rejection_at = CASE WHEN $2 = 'REJECTED' THEN NOW() END, manager_decision = $2
         WHERE action_id = $1`,
        [actionMatch[1], status]
      );
      await client.query(
        `INSERT INTO action_history (action_id, from_status, to_status, details)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [
          actionMatch[1],
          previousStatus,
          status,
          JSON.stringify({
            inventoryChanged: false,
            note: status === "APPROVED"
              ? "Approval records a plan only; inventory changes only on simulated completion."
              : "Rejected plan leaves inventory unchanged.",
          }),
        ]
      );
      const updatedAction = await getAction(actionMatch[1], client);
      const updatedInventory = await getInventoryRows(client);
      return { updatedAction, updatedInventory };
    });
    res.json({
      message: status === "APPROVED"
        ? "Transfer plan approved in simulation; inventory remains unchanged until simulated completion."
        : "Action rejected in simulation; inventory was not changed.",
      action: result.updatedAction,
      inventory: result.updatedInventory,
    });
    return true;
  }
  const completionMatch = pathname.match(/^\/api\/actions\/(\d+)\/complete$/);
  if (method === "POST" && completionMatch) {
    const result = await db.transaction(async (client) => {
      const locked = await client.query(
        `SELECT a.*, p.product_name FROM actions a JOIN products p ON p.sku = a.sku
         WHERE action_id = $1 FOR UPDATE OF a`,
        [completionMatch[1]]
      );
      if (!locked.rowCount) {
        const notFound = new Error("Action not found.");
        notFound.status = 404;
        throw notFound;
      }
      const action = actionRecord(locked.rows[0]);
      if (action.status !== "APPROVED") {
        const conflict = new Error("Only an approved transfer plan can be completed in simulation.");
        conflict.status = 409;
        throw conflict;
      }
      const { donor, target } = await revalidateTransferAction(client, action);
      await client.query(
        `UPDATE inventory SET current_stock = current_stock - $3, last_updated_at = NOW()
         WHERE store_id = $1 AND sku = $2`,
        [action.fromStore, action.sku, action.quantity]
      );
      await client.query(
        `UPDATE inventory SET current_stock = current_stock + $3, last_updated_at = NOW()
         WHERE store_id = $1 AND sku = $2`,
        [action.toStore, action.sku, action.quantity]
      );
      await client.query(
        `UPDATE actions SET status = 'COMPLETED', completed_at = NOW()
         WHERE action_id = $1`,
        [completionMatch[1]]
      );
      await client.query(
        `INSERT INTO action_history (action_id, from_status, to_status, details)
         VALUES ($1,'APPROVED','COMPLETED',$2::jsonb)`,
        [
          completionMatch[1],
          JSON.stringify({
            simulated: true,
            sourceStoreId: donor.storeId,
            destinationStoreId: target.storeId,
            quantity: action.quantity,
            physicalDispatch: false,
          }),
        ]
      );
      return {
        action: await getAction(completionMatch[1], client),
        inventory: await getInventoryRows(client),
      };
    });
    res.json({
      message: "Transfer completed in simulation; no physical dispatch occurred.",
      action: result.action,
      inventory: result.inventory,
    });
    return true;
  }
  if (method === "GET" && pathname === "/api/warehouse-inventory") {
    const result = await db.query(
      `SELECT warehouse_id AS "warehouseId", sku, available_stock AS "availableStock",
        last_updated_at AS "lastUpdatedAt", data_source AS "dataSource"
       FROM warehouse_inventory ORDER BY warehouse_id, sku`
    );
    res.json(result.rows);
    return true;
  }
  if (method === "GET" && pathname === "/api/trucks") {
    const result = await db.query(
      `SELECT truck_id AS "truckId", store_id AS "storeId",
        scheduled_arrival_at AS "scheduledArrivalAt", truck_capacity AS "truckCapacity",
        reserved_capacity AS "reservedCapacity", delivery_status AS "deliveryStatus",
        data_source AS "dataSource"
       FROM trucks ORDER BY scheduled_arrival_at`
    );
    res.json(result.rows);
    return true;
  }
  if (method === "GET" && pathname === "/api/riders") {
    const result = await db.query(
      `SELECT availability_id AS "availabilityId", store_id AS "storeId",
        available_at AS "availableAt", available_rider_count AS "availableRiderCount",
        orders_per_rider_per_hour AS "ordersPerRiderPerHour", data_source AS "dataSource"
       FROM riders ORDER BY available_at DESC`
    );
    res.json(result.rows);
    return true;
  }
  if (method === "GET" && pathname === "/api/deliveries") {
    const result = await db.query(
      `SELECT delivery_id AS "deliveryId", store_id AS "storeId", sku,
        arrival_hour AS "arrivalHour", quantity, data_source AS "dataSource"
       FROM demo_deliveries ORDER BY delivery_id DESC`
    );
    res.json(result.rows);
    return true;
  }
  if (method === "POST" && pathname === "/api/deliveries") {
    const body = req.body || {};
    const storeId = Number(body.storeId);
    if (
      !Number.isInteger(storeId) ||
      storeId <= 0 ||
      typeof body.sku !== "string" ||
      !Number.isInteger(body.hour) ||
      body.hour < 1 ||
      body.hour > 24 ||
      !Number.isInteger(body.quantity) ||
      body.quantity <= 0
    ) {
      res.status(400).json({
        error: "Provide a valid storeId, sku, hour (1-24), and positive quantity.",
      });
      return true;
    }
    const delivery = await db.transaction(async (client) => {
      const item = await client.query(
        `SELECT current_stock, shelf_capacity FROM inventory
         WHERE store_id = $1 AND sku = $2 FOR UPDATE`,
        [storeId, body.sku]
      );
      if (!item.rowCount) {
        const notFound = new Error("Product not found in this store.");
        notFound.status = 404;
        throw notFound;
      }
      if (
        Number(item.rows[0].current_stock) + body.quantity >
        Number(item.rows[0].shelf_capacity)
      ) {
        const badRequest = new Error("Delivery exceeds shelf capacity.");
        badRequest.status = 400;
        throw badRequest;
      }
      const inserted = await client.query(
        `INSERT INTO demo_deliveries (store_id, sku, arrival_hour, quantity)
         VALUES ($1,$2,$3,$4)
         RETURNING delivery_id AS "deliveryId", store_id AS "storeId",
           sku, arrival_hour AS "arrivalHour", quantity`,
        [storeId, body.sku, body.hour, body.quantity]
      );
      return inserted.rows[0];
    });
    res.status(201).json({ message: "Simulated delivery scheduled.", delivery });
    return true;
  }
  return false;
}

module.exports = {
  actionComparison,
  handle,
  haversineKm,
  inventoryIsFresh,
  validCoordinate,
};
