const db = require("./db");
const { buildDemoNetwork, syntheticSource } = require("./demo-bengaluru-network");

async function seedDemoNetwork() {
  if (!db.enabled) {
    throw new Error("DATABASE_URL is required to seed the Bengaluru demo network.");
  }

  const records = buildDemoNetwork();
  await db.transaction(async (client) => {
    for (const { store, inventory } of records) {
      await client.query(
        `INSERT INTO stores (
          store_id, name, address, locality, city, state, latitude, longitude,
          location_source, store_type, verification_status
        ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,'simulated')
        ON CONFLICT (store_id) DO NOTHING`,
        [
          store.storeId,
          store.name,
          store.locality,
          store.city,
          store.state,
          store.latitude,
          store.longitude,
          syntheticSource,
          store.storeType,
        ]
      );
      await client.query(
        `INSERT INTO products (sku, product_name, category)
         VALUES ($1,$2,$3)
         ON CONFLICT (sku) DO NOTHING`,
        [inventory.sku, inventory.product, inventory.category]
      );
      await client.query(
        `INSERT INTO inventory (
          store_id, sku, current_stock, safety_stock, shelf_capacity,
          baseline_hourly_demand, transfer_eta_hours, transport_capacity,
          inventory_source, verification_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'simulated')
        ON CONFLICT (store_id, sku) DO NOTHING`,
        [
          inventory.storeId,
          inventory.sku,
          inventory.stock,
          inventory.safetyStock,
          inventory.shelfCapacity,
          inventory.hourlyDemand,
          inventory.transferEtaHours ?? null,
          inventory.transportCapacity ?? null,
          syntheticSource,
        ]
      );
      await client.query(
        `INSERT INTO trucks (truck_id, store_id, scheduled_arrival_at,
          truck_capacity, reserved_capacity, delivery_status, data_source)
         VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 hour'),100,0,'scheduled',$4)
         ON CONFLICT (truck_id) DO NOTHING`,
        [
          `demo-${inventory.storeId}-${inventory.sku}`,
          inventory.storeId,
          inventory.truckArrivalHour,
          syntheticSource,
        ]
      );
    }
  });
  console.log(`Seeded ${records.length} explicitly simulated Bengaluru stores (conflicts preserved).`);
}

if (require.main === module) {
  seedDemoNetwork()
    .catch((error) => {
      console.error("Bengaluru demo seed failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = { seedDemoNetwork };
