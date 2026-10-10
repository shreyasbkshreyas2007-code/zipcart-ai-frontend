const fs = require("node:fs");
const path = require("node:path");
const { buildDemoNetwork } = require("./demo-bengaluru-network");

function seedJsonDemoNetwork(statePath = path.join(__dirname, "data.json")) {
  const temporaryPath = `${statePath}.tmp`;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (
    !state ||
    !Array.isArray(state.inventory) ||
    !Array.isArray(state.deliveries) ||
    !Array.isArray(state.actions) ||
    !Number.isInteger(state.nextActionId)
  ) {
    throw new Error("Existing JSON persistence has an invalid shape; no data was written.");
  }
  const stores = Array.isArray(state.stores) ? [...state.stores] : [];
  const history = Array.isArray(state.actionHistory) ? state.actionHistory : [];
  const storeIds = new Set([
    ...stores.map((store) => Number(store.storeId)),
    ...state.inventory.map((item) => Number(item.storeId)),
  ]);
  const inventoryKeys = new Set(
    state.inventory.map((item) => `${Number(item.storeId)}\0${item.sku}`)
  );
  let storesAdded = 0;
  let inventoryAdded = 0;

  for (const { store, inventory } of buildDemoNetwork()) {
    if (!storeIds.has(store.storeId)) {
      stores.push(store);
      storeIds.add(store.storeId);
      storesAdded += 1;
    }
    const key = `${inventory.storeId}\0${inventory.sku}`;
    if (!inventoryKeys.has(key)) {
      state.inventory.push({
        ...inventory,
        storeName: store.name,
        locality: store.locality,
        city: store.city,
        state: store.state,
        latitude: store.latitude,
        longitude: store.longitude,
        locationSource: store.locationSource,
      });
      inventoryKeys.add(key);
      inventoryAdded += 1;
    }
  }

  const nextState = {
    inventory: state.inventory,
    stores,
    deliveries: state.deliveries,
    actions: state.actions,
    actionHistory: history,
    nextActionId: state.nextActionId,
  };
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
  return { storesAdded, inventoryAdded };
}

if (require.main === module) {
  try {
    const result = seedJsonDemoNetwork();
    console.log(
      `Added ${result.storesAdded} synthetic stores and ${result.inventoryAdded} synthetic inventory rows. Existing records and action statuses were preserved.`
    );
  } catch (error) {
    console.error("JSON demo network seed failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { seedJsonDemoNetwork };
