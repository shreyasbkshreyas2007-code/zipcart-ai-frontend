const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:3000"
).replace(/\/+$/, "");

export type DemandScenario = "baseline" | "cricket" | "festival" | "rain";
export type ActionStatus = "APPROVED" | "REJECTED";

export function getHealth(): Promise<unknown> {
  return requestJSON("/health");
}

export function updateInventory(
  storeId: number,
  sku: string,
  record: {
    stock: number;
    hourlyDemand: number;
    shelfCapacity: number;
    safetyStock?: number;
  }
): Promise<unknown> {
  return requestJSON(
    `/api/inventory/${encodeURIComponent(storeId)}/${encodeURIComponent(sku)}`,
    {
      method: "PUT",
      body: JSON.stringify(record),
    }
  );
}

async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error(
      `Could not reach the Zipcart API at ${API_BASE_URL}. Check the backend and NEXT_PUBLIC_API_BASE_URL, then retry.`
    );
  }

  const body = await response.text();
  let payload: unknown;
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Zipcart API returned malformed JSON (${response.status}).`);
    }
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Zipcart API request failed with status ${response.status}.`;
    throw new Error(message);
  }
  if (payload === undefined) {
    throw new Error("Zipcart API returned an empty response.");
  }
  return payload as T;
}

export function addHourlySales(record: {
  storeId: number;
  sku: string;
  hourStart: string;
  quantitySold: number;
  dataSource: string;
}): Promise<unknown> {
  return requestJSON("/api/hourly-sales", {
    method: "POST",
    body: JSON.stringify(record),
  });
}

function scenarioQuery(scenario: DemandScenario, eventStartHour: number) {
  const params = new URLSearchParams({ scenario });
  if (scenario !== "baseline") {
    params.set("eventStartHour", String(eventStartHour));
  }
  return params.toString();
}

export function getInventory(): Promise<unknown> {
  return requestJSON("/api/inventory");
}

export function getStores(): Promise<unknown> {
  return requestJSON("/api/stores");
}

export type StoreInput = {
  storeId?: number;
  name: string;
  locality: string;
  address?: string;
  city?: string;
  state?: string;
  latitude?: number;
  longitude?: number;
  locationSource?: string;
  active?: boolean;
};

export function createStore(record: StoreInput): Promise<unknown> {
  return requestJSON("/api/stores", {
    method: "POST",
    body: JSON.stringify(record),
  });
}

export function updateStore(storeId: number, record: StoreInput): Promise<unknown> {
  return requestJSON(`/api/stores/${encodeURIComponent(storeId)}`, {
    method: "PUT",
    body: JSON.stringify(record),
  });
}

export function getBengaluruAreas(): Promise<unknown> {
  return requestJSON("/api/bengaluru-areas");
}

export function getStockRescue(input: {
  storeId: number;
  sku: string;
  radiusKm: number;
}): Promise<unknown> {
  const query = new URLSearchParams({
    storeId: String(input.storeId),
    sku: input.sku,
    radiusKm: String(input.radiusKm),
  });
  return requestJSON(`/api/stock-rescue?${query}`);
}

export function createTransferProposal(input: {
  storeId: number;
  donorStoreId: number;
  sku: string;
  scenario: DemandScenario;
}): Promise<unknown> {
  return requestJSON("/api/transfers/proposals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getStore(storeId: number): Promise<unknown> {
  return requestJSON(`/api/stores/${encodeURIComponent(storeId)}`);
}

export function getNearbyStores(
  latitude: number,
  longitude: number,
  radiusKm: number
): Promise<unknown> {
  const query = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    radiusKm: String(radiusKm),
  });
  return requestJSON(`/api/stores/nearby?${query}`);
}

export function getHourlySales(storeId: number, sku: string): Promise<unknown> {
  const query = new URLSearchParams({ storeId: String(storeId), sku });
  return requestJSON(`/api/hourly-sales?${query}`);
}

export function getEvents(): Promise<unknown> {
  return requestJSON("/api/events");
}

export function addEvent(record: Record<string, unknown>): Promise<unknown> {
  return requestJSON("/api/events", {
    method: "POST",
    body: JSON.stringify(record),
  });
}

export function getDeliveries(): Promise<unknown> {
  return requestJSON("/api/deliveries");
}

export function scheduleDelivery(record: {
  storeId: number;
  sku: string;
  hour: number;
  quantity: number;
}): Promise<unknown> {
  return requestJSON("/api/deliveries", {
    method: "POST",
    body: JSON.stringify(record),
  });
}

export function getWarehouseInventory(): Promise<unknown> {
  return requestJSON("/api/warehouse-inventory");
}

export function getTrucks(): Promise<unknown> {
  return requestJSON("/api/trucks");
}

export function getRiderAvailability(): Promise<unknown> {
  return requestJSON("/api/riders");
}

export function getScenarios(): Promise<unknown> {
  return requestJSON("/api/scenarios");
}

export function addInventory(record: Record<string, unknown>): Promise<unknown> {
  return requestJSON("/api/inventory", {
    method: "POST",
    body: JSON.stringify(record),
  });
}

export function getForecast(
  storeId: number,
  sku: string,
  scenario: DemandScenario,
  eventStartHour: number
): Promise<unknown> {
  return requestJSON(
    `/api/forecast/${encodeURIComponent(storeId)}/${encodeURIComponent(sku)}?hours=4&${scenarioQuery(scenario, eventStartHour)}`
  );
}

export function getActionComparison(
  storeId: number,
  sku: string,
  scenario: DemandScenario,
  eventStartHour: number
): Promise<unknown> {
  return requestJSON(
    `/api/action-comparison/${encodeURIComponent(storeId)}/${encodeURIComponent(sku)}?${scenarioQuery(scenario, eventStartHour)}`
  );
}

export function getRecommendation(
  storeId: number,
  sku: string,
  scenario: DemandScenario,
  eventStartHour: number
): Promise<unknown> {
  return requestJSON(
    `/api/recommendations/${encodeURIComponent(storeId)}/${encodeURIComponent(sku)}?${scenarioQuery(scenario, eventStartHour)}`
  );
}

export function getActions(): Promise<unknown> {
  return requestJSON("/api/actions");
}

export function updateAction(
  actionId: string,
  status: ActionStatus
): Promise<unknown> {
  return requestJSON(`/api/actions/${encodeURIComponent(actionId)}`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export function completeAction(actionId: string): Promise<unknown> {
  return requestJSON(`/api/actions/${encodeURIComponent(actionId)}/complete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
