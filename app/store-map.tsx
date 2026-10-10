"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  createStore,
  createTransferProposal,
  getBengaluruAreas,
  getInventory,
  getStockRescue,
  getStores,
  updateStore,
  type StoreInput,
} from "./api";

type Store = {
  storeId: number;
  name: string;
  locality?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationSource?: string | null;
  verificationStatus?: string;
};

type InventoryItem = {
  storeId: number;
  sku: string;
  product: string;
  stock: number;
  hourlyDemand: number;
  truckArrivalHour: number;
  shelfCapacity: number;
  safetyStock?: number;
  verificationStatus?: string;
};

type Candidate = {
  storeId: number;
  name: string;
  area: string | null;
  stock: number;
  hourlyDemand: number;
  safetyStock: number | null;
  shelfCapacity: number;
  truckArrivalHour: number;
  distanceKm: number | null;
  distanceSource: string;
  locationSource?: string | null;
  safeTransferableSurplus: number | null;
  stockAvailableAtTransfer: number | null;
  donorDemandUntilReplenishment: number | null;
  transferEtaHours: number | null;
  estimatedTransferQuantity: number;
  feasible: boolean;
  constraints: string[];
  inventorySource?: string;
  verificationStatus?: string;
};

type RescueResponse = {
  target: {
    storeId: number;
    name?: string;
    area?: string | null;
    sku: string;
    product: string;
    currentStock: number;
    hourlyDemand: number;
    truckArrivalHour: number;
    stockoutInHours: number | null;
    expectedShortageBeforeTruck: number;
    shelfCapacity: number;
    dataQuality?: string;
  };
  candidates: Candidate[];
  radiusKm: number;
  proximityVerified: boolean;
  dataQuality?: string;
  distanceType?: string;
};

const markerIcon = L.divIcon({
  className: "zipcart-map-marker",
  html: "<span></span>",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

function FitMarkers({ stores }: { stores: Store[] }) {
  const map = useMap();
  useEffect(() => {
    const located = stores.filter(
      (store) =>
        Number.isFinite(store.latitude) && Number.isFinite(store.longitude)
    );
    if (located.length === 0) return;
    const points = located.map(
      (store) => [store.latitude!, store.longitude!] as [number, number]
    );
    if (points.length === 1) map.setView(points[0], 14);
    else map.fitBounds(points, { padding: [28, 28], maxZoom: 14 });
  }, [map, stores]);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStore(value: unknown): value is Store {
  return (
    isRecord(value) &&
    Number.isInteger(value.storeId) &&
    typeof value.name === "string"
  );
}

function isInventory(value: unknown): value is InventoryItem {
  return (
    isRecord(value) &&
    Number.isInteger(value.storeId) &&
    typeof value.sku === "string" &&
    typeof value.product === "string" &&
    Number.isFinite(value.stock) &&
    Number.isFinite(value.hourlyDemand) &&
    Number.isFinite(value.truckArrivalHour) &&
    Number.isFinite(value.shelfCapacity)
  );
}

function inventoryStatus(item: Pick<InventoryItem, "stock" | "hourlyDemand" | "truckArrivalHour" | "safetyStock">) {
  if (item.stock <= 0) return "Out of Stock";
  const warningFloor = item.safetyStock ??
    item.hourlyDemand * item.truckArrivalHour;
  return item.stock <= warningFloor ? "Low Stock" : "In Stock";
}

function sameArea(store: Store, area: string) {
  return area === "all" || store.locality === area;
}

export default function StoreMap({
  onActionsChanged,
}: {
  onActionsChanged: () => void;
}) {
  const [stores, setStores] = useState<Store[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [area, setArea] = useState("all");
  const [storeId, setStoreId] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [radiusKm, setRadiusKm] = useState("10");
  const [rescue, setRescue] = useState<RescueResponse | null>(null);
  const [mapVisible, setMapVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [proposalStore, setProposalStore] = useState<number | null>(null);
  const [editingStoreId, setEditingStoreId] = useState("");
  const [storeSaving, setStoreSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const [storesPayload, inventoryPayload, areasPayload] = await Promise.all([
        getStores(),
        getInventory(),
        getBengaluruAreas(),
      ]);
      if (
        !isRecord(storesPayload) ||
        !Array.isArray(storesPayload.stores) ||
        !storesPayload.stores.every(isStore)
      ) {
        throw new Error("The store endpoint returned an invalid store list.");
      }
      if (!Array.isArray(inventoryPayload) || !inventoryPayload.every(isInventory)) {
        throw new Error("The inventory endpoint returned an invalid inventory list.");
      }
      if (!isRecord(areasPayload) || !Array.isArray(areasPayload.areas) ||
          !areasPayload.areas.every((value) => typeof value === "string")) {
        throw new Error("The Bengaluru areas endpoint returned an invalid area list.");
      }
      setStores(storesPayload.stores);
      setInventory(inventoryPayload);
      setAreas(areasPayload.areas);
      setStoreId((current) => current || String(inventoryPayload[0]?.storeId ?? ""));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load store inventory.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const areaStores = useMemo(
    () => stores.filter((store) => sameArea(store, area)),
    [stores, area]
  );
  const selectableStores = useMemo(
    () =>
      areaStores.filter((store) =>
        inventory.some((item) => item.storeId === store.storeId)
      ),
    [areaStores, inventory]
  );
  const products = useMemo(() => {
    const bySku = new Map<string, InventoryItem>();
    for (const item of inventory) {
      if (!bySku.has(item.sku)) bySku.set(item.sku, item);
    }
    return [...bySku.values()];
  }, [inventory]);
  const matchingProducts = useMemo(
    () =>
      products.filter((item) =>
        `${item.product} ${item.sku}`.toLowerCase().includes(productSearch.trim().toLowerCase())
      ),
    [products, productSearch]
  );
  const selectedStore = selectableStores.find((store) => String(store.storeId) === storeId);
  const selectedInventory = inventory.find(
    (item) =>
      item.storeId === Number(storeId) &&
      (item.sku.toLowerCase() === productSearch.trim().toLowerCase() ||
        item.product.toLowerCase() === productSearch.trim().toLowerCase())
  );
  const candidates = (rescue?.candidates || []).filter((candidate) => {
    if (statusFilter === "all") return true;
    const candidateStatus = inventoryStatus({
      stock: candidate.stock,
      hourlyDemand: candidate.hourlyDemand,
      truckArrivalHour: candidate.truckArrivalHour,
      safetyStock: candidate.safetyStock ?? undefined,
    });
    return candidateStatus === statusFilter;
  });

  async function findNearbyStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const parsedRadius = Number(radiusKm);
    if (!selectedStore || !selectedInventory) {
      setNotice("Choose a destination store and a product that exists in its backend inventory.");
      return;
    }
    if (!Number.isFinite(parsedRadius) || parsedRadius <= 0 || parsedRadius > 100) {
      setNotice("Enter a search radius greater than 0 and no more than 100 km.");
      return;
    }
    setSearching(true);
    setRescue(null);
    try {
      const payload = await getStockRescue({
        storeId: selectedStore.storeId,
        sku: selectedInventory.sku,
        radiusKm: parsedRadius,
      });
      if (!isRecord(payload) || !isRecord(payload.target) ||
          !Array.isArray(payload.candidates) || !payload.candidates.every(isRecord)) {
        throw new Error("The nearby-stock endpoint returned an invalid result.");
      }
      setRescue(payload as unknown as RescueResponse);
      if (payload.candidates.length === 0) {
        setNotice(
          area === "all"
            ? "No other store currently carries this SKU in backend inventory."
            : `No same-SKU inventory records were found in ${area}.`
        );
      }
    } catch (searchError) {
      setNotice(
        searchError instanceof Error
          ? `Nearby stock search failed: ${searchError.message}`
          : "Nearby stock search failed."
      );
    } finally {
      setSearching(false);
    }
  }

  async function proposeTransfer(candidate: Candidate) {
    if (!rescue || !candidate.feasible || !candidate.estimatedTransferQuantity) return;
    setProposalStore(candidate.storeId);
    setNotice("");
    try {
      const response = await createTransferProposal({
        storeId: rescue.target.storeId,
        donorStoreId: candidate.storeId,
        sku: rescue.target.sku,
        scenario: "baseline",
      });
      const result = isRecord(response) && typeof response.message === "string"
        ? response.message
        : "Transfer plan sent to the Action Center for manager approval.";
      setNotice(result);
      onActionsChanged();
    } catch (proposalError) {
      setNotice(
        proposalError instanceof Error
          ? `Could not create transfer request: ${proposalError.message}`
          : "Could not create transfer request."
      );
    } finally {
      setProposalStore(null);
    }
  }

  async function saveStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const form = new FormData(event.currentTarget);
    const rawId = String(form.get("storeId") || "");
    const rawLatitude = String(form.get("latitude") || "").trim();
    const rawLongitude = String(form.get("longitude") || "").trim();
    const input: StoreInput = {
      name: String(form.get("name") || "").trim(),
      locality: String(form.get("locality") || ""),
      address: String(form.get("address") || "").trim(),
      city: "Bengaluru",
      state: "Karnataka",
      ...(rawLatitude && rawLongitude
        ? {
            latitude: Number(rawLatitude),
            longitude: Number(rawLongitude),
            locationSource: String(form.get("locationSource") || "").trim(),
          }
        : {}),
      active: true,
    };
    if (!editingStoreId) input.storeId = Number(rawId);
    if ((rawLatitude && !rawLongitude) || (!rawLatitude && rawLongitude)) {
      setNotice("Enter both coordinates, or leave both blank.");
      return;
    }
    if (rawLatitude && rawLongitude && !input.locationSource) {
      setNotice("Coordinates need an explicit source label; simulated coordinates cannot be marked verified.");
      return;
    }
    setStoreSaving(true);
    try {
      const saved = editingStoreId
        ? await updateStore(Number(editingStoreId), input)
        : await createStore(input);
      const store = isStore(saved) ? saved : null;
      setNotice(
        store
          ? `${store.name} saved as a simulated store record.`
          : "Store record saved in the configured backend."
      );
      setEditingStoreId("");
      event.currentTarget.reset();
      await loadData();
    } catch (saveError) {
      setNotice(
        saveError instanceof Error
          ? `Could not save store: ${saveError.message}`
          : "Could not save store."
      );
    } finally {
      setStoreSaving(false);
    }
  }

  const targetStore = rescue
    ? stores.find((store) => store.storeId === rescue.target.storeId)
    : undefined;
  const mapStores = rescue
    ? [targetStore, ...rescue.candidates.map((candidate) => stores.find((store) => store.storeId === candidate.storeId))]
        .filter((store): store is Store => Boolean(store))
    : [];
  const mappableStores = mapStores.filter(
    (store) => Number.isFinite(store.latitude) && Number.isFinite(store.longitude)
  );

  return (
    <div className="store-map-page">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>Nearby-store stock rescue</h3>
            <p>
              Find same-SKU stock, protect donor safety stock, and prepare a manager-approved simulated transfer.
            </p>
          </div>
          <button className="secondary-button" onClick={() => void loadData()} disabled={loading}>
            Refresh stores
          </button>
        </div>
        <p className="disclaimer">
          Demo locations and inventory are not verified Zipcart operations. No physical transfer or dispatch is initiated.
        </p>
        {error && (
          <div className="notice notice-warning" role="status">
            <span>{error}</span>
            <button className="small-button" onClick={() => void loadData()} disabled={loading}>
              Retry
            </button>
          </div>
        )}
        {notice && <p className="store-map-notice" role="status">{notice}</p>}
        {loading ? (
          <p className="empty">Loading stores and inventory from the backend…</p>
        ) : (
          <>
            <form className="nearby-search rescue-search" onSubmit={findNearbyStock}>
              <label>
                Bengaluru area
                <select value={area} onChange={(event) => { setArea(event.target.value); setRescue(null); }}>
                  <option value="all">All areas</option>
                  {areas.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>
                Destination store
                <select
                  value={storeId}
                  onChange={(event) => { setStoreId(event.target.value); setRescue(null); }}
                >
                  <option value="">Choose store</option>
                  {selectableStores.map((store) => (
                    <option key={store.storeId} value={store.storeId}>
                      {store.name} · #{store.storeId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Product / SKU
                <input
                  list="rescue-products"
                  value={productSearch}
                  onChange={(event) => { setProductSearch(event.target.value); setRescue(null); }}
                  placeholder="Search by product or SKU"
                  required
                />
                <datalist id="rescue-products">
                  {matchingProducts.map((item) => (
                    <option key={item.sku} value={item.sku}>{item.product}</option>
                  ))}
                </datalist>
              </label>
              <label>
                Search radius (km)
                <input
                  type="number"
                  min="0.1"
                  max="100"
                  step="any"
                  value={radiusKm}
                  onChange={(event) => setRadiusKm(event.target.value)}
                  required
                />
              </label>
              <button className="primary" type="submit" disabled={searching || loading}>
                {searching ? "Checking stock…" : "Find Nearby Stock"}
              </button>
            </form>
            <div className="store-filters">
              <label>
                Donor stock status
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="all">All</option>
                  <option value="In Stock">In Stock</option>
                  <option value="Low Stock">Low Stock</option>
                  <option value="Out of Stock">Out of Stock</option>
                </select>
              </label>
              <div className="rescue-view-toggle" role="group" aria-label="Nearby stores view">
                <button type="button" className={!mapVisible ? "active" : ""} onClick={() => setMapVisible(false)}>
                  Show Nearby Stores list
                </button>
                <button type="button" className={mapVisible ? "active" : ""} onClick={() => setMapVisible(true)}>
                  Show Nearby Stores map
                </button>
              </div>
            </div>
            {rescue && (
              <section className="rescue-summary" aria-label="Destination stock risk">
                <div>
                  <span className="data-tag">Destination · {rescue.target.name || `Store ${rescue.target.storeId}`}</span>
                  <h4>{rescue.target.product} <small>{rescue.target.sku}</small></h4>
                  <p>{rescue.target.currentStock} units · {rescue.target.hourlyDemand} units/hour · truck in {rescue.target.truckArrivalHour}h</p>
                </div>
                <div className="rescue-risk">
                  <b>{rescue.target.stockoutInHours === null ? "No predicted stockout" : `Stockout in ${rescue.target.stockoutInHours.toFixed(1)}h`}</b>
                  <span>{rescue.target.expectedShortageBeforeTruck} unmet units before the truck</span>
                </div>
                <p className="data-quality">{rescue.target.dataQuality || rescue.dataQuality}</p>
              </section>
            )}
            <details className="store-admin-panel">
              <summary>Add or edit a demo store</summary>
              <p className="disclaimer">
                Store IDs, names and addresses are operator-entered. Coordinates must be sourced and are never automatically verified.
              </p>
              <form className="nearby-search" onSubmit={(event) => void saveStore(event)}>
                <label>
                  Edit existing store
                  <select
                    value={editingStoreId}
                    onChange={(event) => setEditingStoreId(event.target.value)}
                  >
                    <option value="">Add new store</option>
                    {stores.map((store) => (
                      <option key={store.storeId} value={store.storeId}>
                        {store.name} · #{store.storeId}
                      </option>
                    ))}
                  </select>
                </label>
                {!editingStoreId && (
                  <label>
                    Store ID
                    <input name="storeId" type="number" min="1" step="1" required />
                  </label>
                )}
                <label>
                  Store name
                  <input name="name" required defaultValue={stores.find((store) => String(store.storeId) === editingStoreId)?.name || ""} />
                </label>
                <label>
                  Bengaluru area
                  <select
                    name="locality"
                    required
                    defaultValue={stores.find((store) => String(store.storeId) === editingStoreId)?.locality || area}
                  >
                    <option value="">Choose area</option>
                    {areas.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label>
                  Address (optional)
                  <input name="address" defaultValue={stores.find((store) => String(store.storeId) === editingStoreId)?.locality || ""} />
                </label>
                <label>
                  Latitude (optional)
                  <input name="latitude" type="number" min="-90" max="90" step="any" defaultValue={stores.find((store) => String(store.storeId) === editingStoreId)?.latitude ?? ""} />
                </label>
                <label>
                  Longitude (optional)
                  <input name="longitude" type="number" min="-180" max="180" step="any" defaultValue={stores.find((store) => String(store.storeId) === editingStoreId)?.longitude ?? ""} />
                </label>
                <label>
                  Coordinate source (required with coordinates)
                  <input name="locationSource" defaultValue={stores.find((store) => String(store.storeId) === editingStoreId)?.locationSource || ""} />
                </label>
                <button className="primary" type="submit" disabled={storeSaving}>
                  {storeSaving ? "Saving…" : editingStoreId ? "Save store changes" : "Add store"}
                </button>
              </form>
            </details>
            {rescue && (
              <>
                {mapVisible ? (
                  <div className="store-map-layout">
                    <div className="store-map-canvas" aria-label="Map of selected and nearby store records">
                      <MapContainer center={[12.9716, 77.5946]} zoom={11} scrollWheelZoom className="leaflet-map">
                        <TileLayer
                          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
                          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />
                        <FitMarkers stores={mappableStores} />
                        {mappableStores.map((store) => (
                          <Marker key={store.storeId} position={[store.latitude!, store.longitude!]} icon={markerIcon}>
                            <Popup>{store.name} · {store.locality || "Area unavailable"} · {store.verificationStatus || "unverified"}</Popup>
                          </Marker>
                        ))}
                      </MapContainer>
                    </div>
                    {mappableStores.length === 0 && (
                      <p className="empty">Coordinates are unavailable or not verified; use the nearby-store list instead of an invented map location.</p>
                    )}
                  </div>
                ) : (
                  <div className="table-scroll rescue-table-scroll">
                    {candidates.length === 0 ? (
                      <p className="empty">No matching donor inventory is available for these filters.</p>
                    ) : (
                      <table className="rescue-table">
                        <thead>
                          <tr>
                            <th>Potential donor</th>
                            <th>Distance</th>
                            <th>Stock / demand</th>
                            <th>Safe surplus</th>
                            <th>Transfer</th>
                            <th>Feasibility</th>
                          </tr>
                        </thead>
                        <tbody>
                          {candidates.map((candidate) => (
                            <tr key={candidate.storeId}>
                              <td>
                                <b>{candidate.name}</b>
                                <small>{candidate.area || "Area unavailable"} · {candidate.verificationStatus || "unverified"}</small>
                              </td>
                              <td>
                                {candidate.distanceKm === null ? "Unknown" : `${candidate.distanceKm.toFixed(2)} km`}
                                <small>{candidate.distanceKm === null ? "Location not verified" : candidate.locationSource?.includes("illustrative") ? "Illustrative straight-line distance" : candidate.distanceSource}</small>
                              </td>
                              <td>{candidate.stock} units<small>{candidate.hourlyDemand} units/hour · truck {candidate.truckArrivalHour}h</small></td>
                              <td>{candidate.safeTransferableSurplus === null ? "Unverified" : `${candidate.safeTransferableSurplus} units`}<small>{candidate.safetyStock === null ? "Safety stock missing" : `Safety stock ${candidate.safetyStock}`}</small></td>
                              <td>{candidate.estimatedTransferQuantity > 0 ? `${candidate.estimatedTransferQuantity} units proposed` : "Not calculated"}<small>{candidate.transferEtaHours === null ? "ETA missing" : `ETA ${candidate.transferEtaHours}h`}</small></td>
                              <td>
                                <span className={`pill ${candidate.feasible ? "pill-good" : "pill-warn"}`}>
                                  {candidate.feasible ? "Feasible in simulation" : "Unverified"}
                                </span>
                                {candidate.constraints.length > 0 && <small>{candidate.constraints.join(" ")}</small>}
                                {candidate.feasible && (
                                  <button
                                    className="small-button rescue-propose"
                                    disabled={proposalStore !== null}
                                    onClick={() => void proposeTransfer(candidate)}
                                  >
                                    {proposalStore === candidate.storeId ? "Submitting…" : "Request manager approval"}
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
                {!rescue.proximityVerified && (
                  <p className="disclaimer">
                    One or more candidate locations lack coordinates. Same-SKU stock is shown for review, but distance and “nearby” status are unverified. Transfer feasibility uses the listed ETA and capacity inputs; no road routing or live travel-time data is available.
                  </p>
                )}
                <p className="map-attribution">Map tiles and imported geographic records: © OpenStreetMap contributors.</p>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
