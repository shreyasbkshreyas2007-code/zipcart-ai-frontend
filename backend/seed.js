const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
const { migrate } = require("./migrate");

const state = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data.json"), "utf8")
);

function inferCategory(product) {
  const name = product.toLowerCase();
  if (/drink|cola|soda|water|juice|tea|coffee/.test(name)) return "beverages";
  if (/snack|crisp|chip|biscuit|cookie|nuts/.test(name)) return "snacks";
  if (/sweet|cake|chocolate|dessert/.test(name)) return "sweets";
  if (/fruit|vegetable|produce/.test(name)) return "produce";
  if (/soap|clean|tissue|essential|umbrella/.test(name)) return "essentials";
  return "other";
}

async function seed() {
  if (!db.enabled) throw new Error("DATABASE_URL is required to seed the database.");
  await migrate();
  await db.transaction(async (client) => {
    for (const item of state.inventory) {
      const storeName = item.storeName || `Store ${item.storeId}`;
      await client.query(
        `INSERT INTO stores (store_id, name, store_type, verification_status, location_source)
         VALUES ($1, $2, 'simulated operational location', 'simulated', 'legacy demo records')
         ON CONFLICT (store_id) DO NOTHING`,
        [item.storeId, storeName]
      );
      await client.query(
        `INSERT INTO products (
           sku, product_name, category, selling_price, unit_cost, unit_margin
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (sku) DO NOTHING`,
        [
          item.sku,
          item.product,
          item.category || inferCategory(item.product),
          item.unitPrice ?? null,
          item.unitCost ?? null,
          item.unitMargin ??
            (item.unitPrice !== undefined && item.unitCost !== undefined
              ? item.unitPrice - item.unitCost
              : null),
        ]
      );
      await client.query(
        `INSERT INTO inventory (
           store_id, sku, current_stock, safety_stock, shelf_capacity,
           baseline_hourly_demand, transfer_eta_hours, transport_capacity,
           earlier_truck_available, earlier_truck_arrival_hour, earlier_truck_units,
           shelf_space_shareable, inventory_source, verification_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'legacy data.json demo seed','simulated')
         ON CONFLICT (store_id, sku) DO NOTHING`,
        [
          item.storeId,
          item.sku,
          item.stock,
          item.safetyStock ?? null,
          item.shelfCapacity,
          item.hourlyDemand,
          item.transferEtaHours ?? null,
          item.transportCapacity ?? null,
          item.earlierTruckAvailable ?? null,
          item.earlierTruckArrivalHour ?? null,
          item.earlierTruckUnits ?? null,
          item.shelfSpaceShareable ?? null,
        ]
      );
      const truckId = `demo-${item.storeId}-${item.sku}`;
      await client.query(
        `INSERT INTO trucks (
           truck_id, store_id, scheduled_arrival_at, data_source, delivery_status
         ) VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'), 'legacy demo data', 'scheduled')
         ON CONFLICT (truck_id) DO NOTHING`,
        [truckId, item.storeId, item.truckArrivalHour]
      );
    }

    for (const delivery of state.deliveries) {
      await client.query(
        `INSERT INTO demo_deliveries (store_id, sku, arrival_hour, quantity, data_source)
         SELECT $1, $2, $3, $4, 'legacy data.json demo seed'
         WHERE NOT EXISTS (
           SELECT 1 FROM demo_deliveries
           WHERE store_id = $1 AND sku = $2 AND arrival_hour = $3 AND quantity = $4
         )`,
        [delivery.storeId, delivery.sku, delivery.hour, delivery.quantity]
      );
    }

    for (const action of state.actions) {
      await client.query(
        `INSERT INTO actions (
           action_id, action_type, sku, quantity, source_store_id,
           destination_store_id, status, feasible, required_quantity,
           estimated_unfilled_units_after_action, estimated_impact,
           explanation, constraints, scenario, created_at, approval_at,
           rejection_at, manager_decision
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
           $12, $13::jsonb, $14, COALESCE($15::timestamptz, NOW()),
           CASE WHEN $7 = 'APPROVED' THEN COALESCE($15::timestamptz, NOW()) END,
           CASE WHEN $7 = 'REJECTED' THEN COALESCE($15::timestamptz, NOW()) END,
           $7
         )
         ON CONFLICT (action_id) DO NOTHING`,
        [
          Number(action.id),
          action.action,
          action.sku,
          action.quantity,
          action.fromStore,
          action.toStore,
          action.status,
          action.feasible,
          action.requiredQuantity,
          action.estimatedUnfilledUnitsAfterAction,
          JSON.stringify({
            estimatedUnfilledUnitsAfterAction:
              action.estimatedUnfilledUnitsAfterAction,
          }),
          action.reason,
          JSON.stringify(action.constraints || []),
          action.scenario || "baseline",
          action.processedAt || null,
        ]
      );
    }
    await client.query(
      `SELECT setval(
        pg_get_serial_sequence('stores', 'store_id'),
        GREATEST(COALESCE((SELECT MAX(store_id) FROM stores), 1), 1),
        TRUE
      )`
    );
    await client.query(
      `SELECT setval(
        pg_get_serial_sequence('actions', 'action_id'),
        GREATEST(COALESCE((SELECT MAX(action_id) FROM actions), 1), 1),
        TRUE
      )`
    );
  });
}

if (require.main === module) {
  seed()
    .then(() => console.log("Existing demo records were seeded without overwriting database rows."))
    .catch((error) => {
      console.error("Database seed failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = { seed };
