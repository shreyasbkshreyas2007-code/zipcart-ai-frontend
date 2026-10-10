"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  addInventory as postInventory,
  completeAction,
  getActionComparison as fetchActionComparison,
  getActions,
  getForecast as fetchForecast,
  getInventory,
  getRecommendation,
  getScenarios,
  updateAction,
  type ActionStatus as ApiActionStatus,
  type DemandScenario,
} from "./api";

const StoreMap = dynamic(() => import("./store-map"), {
  ssr: false,
  loading: () => <section className="panel"><p className="empty">Loading store map…</p></section>,
});

type Category =
  | "beverages"
  | "snacks"
  | "sweets"
  | "produce"
  | "essentials"
  | "other";

type InventoryItem = {
  storeId: number;
  storeName?: string;
  sku: string;
  product: string;
  category: Category;
  stock: number;
  hourlyDemand: number;
  shelfCapacity: number;
  truckArrivalHour: number;
  safetyStock?: number;
  unitPrice?: number;
  unitCost?: number;
  unitMargin?: number;
  inventorySource?: string;
  verificationStatus?: string;
  transferEtaHours?: number;
  transportCapacity?: number;
  earlierTruckAvailable?: boolean;
  earlierTruckArrivalHour?: number;
  earlierTruckUnits?: number;
  shelfSpaceShareable?: boolean;
  source: "backend" | "demo" | "user";
};

type ActionOption = {
  type?: string;
  title: string;
  feasible: boolean;
  quantity: number;
  reason: string;
  constraints: string[];
  expectedShortage: number;
  cost?: number;
  actionId?: string;
  fromStore?: number | null;
  sourceAction?: ActionRecord;
};
type ReasoningStep = {
  step: string;
  status: "passed" | "failed" | "needs_verification" | "missing" | "pending";
  detail: string;
};
type ActionComparison = {
  options: ActionOption[];
  reasoning: ReasoningStep[];
};
type ActionRecord = {
  id: string;
  status: ApiActionStatus | "PENDING" | "COMPLETED";
  action: string;
  feasible: boolean;
  fromStore: number | null;
  toStore: number;
  storeId: number;
  quantity: number;
  requiredQuantity: number;
  sku: string;
  product: string;
  constraints: string[];
  scenario: string;
  estimatedUnfilledUnitsAfterAction: number;
  reason: string;
  processedAt?: string;
  completedAt?: string;
};
type HourProjection = {
  hour: number;
  event: string;
  baselineDemand: number;
  upliftPercent: number;
  forecastDemand: number;
  scheduledDelivery: number;
  projectedStock: number;
  stockoutRisk: boolean;
  estimatedUnfilledDemand: number;
};
type Forecast = {
  storeId: number;
  sku: string;
  product: string;
  currentStock: number;
  truckArrivalHour: number;
  scenario: {
    name: string;
    label: string;
    upliftPercent: number;
    appliesToCategories: string[];
    startHour: number | null;
    endHour: number | null;
    dataQuality: string;
  };
  stockoutInHours: number | null;
  expectedShortageBeforeTruck: number;
  demandBeforeTruck: number;
  forecast: HourProjection[];
};

const navigation = [
  { label: "Dashboard", icon: "▦" },
  { label: "Stores", icon: "⌖" },
  { label: "Inventory", icon: "▤" },
  { label: "Forecast", icon: "⌁" },
  { label: "Recommendations", icon: "✳" },
  { label: "Action Center", icon: "✓" },
];

type ScenarioInfo = {
  label: string;
  upliftPercent: number;
  categories: string[];
  durationHours: number;
  defaultStartHour: number;
  source: string;
};

const formatMoney = (value: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
function storeLabel(item: InventoryItem) {
  return item.storeName || `Store ${item.storeId}`;
}

function inferCategory(product: string): Category {
  const name = product.toLowerCase();
  if (/drink|cola|soda|water|juice|tea|coffee/.test(name)) return "beverages";
  if (/snack|crisp|chip|biscuit|cookie|nuts/.test(name)) return "snacks";
  if (/sweet|cake|chocolate|dessert/.test(name)) return "sweets";
  if (/fruit|vegetable|produce/.test(name)) return "produce";
  if (/soap|clean|tissue|essential|umbrella/.test(name)) return "essentials";
  return "other";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeActionComparison(data: unknown): ActionComparison {
  if (typeof data !== "object" || data === null) {
    throw new Error("The action-comparison response is invalid.");
  }
  const payload = data as Record<string, unknown>;
  if (!Array.isArray(payload.options) || !Array.isArray(payload.reasoning)) {
    throw new Error("The action-comparison response is incomplete.");
  }
  const options = payload.options.map((value) => {
    if (typeof value !== "object" || value === null) {
      throw new Error("The action-comparison response contains an invalid option.");
    }
    const option = value as Record<string, unknown>;
    if (
      typeof option.type !== "string" ||
      typeof option.title !== "string" ||
      typeof option.feasible !== "boolean" ||
      typeof option.quantity !== "number" ||
      typeof option.reason !== "string" ||
      !Array.isArray(option.constraints) ||
      !option.constraints.every((constraint) => typeof constraint === "string") ||
      typeof option.expectedShortage !== "number"
    ) {
      throw new Error("The action-comparison response contains invalid option fields.");
    }
    return {
      type: option.type,
      title: option.title,
      feasible: option.feasible,
      quantity: option.quantity,
      reason: option.reason,
      constraints: option.constraints as string[],
      expectedShortage: option.expectedShortage,
      fromStore:
        typeof option.fromStore === "number" ? option.fromStore : undefined,
      cost: typeof option.actionCost === "number" ? option.actionCost : undefined,
    };
  });
  const reasoning = payload.reasoning.map((value) => {
    if (typeof value !== "object" || value === null) {
      throw new Error("The agent reasoning response contains an invalid step.");
    }
    const step = value as Record<string, unknown>;
    if (
      typeof step.step !== "string" ||
      !["passed", "failed", "needs_verification", "missing", "pending"].includes(
        String(step.status)
      ) ||
      typeof step.detail !== "string"
    ) {
      throw new Error("The agent reasoning response contains invalid step fields.");
    }
    return {
      step: step.step,
      status: step.status as ReasoningStep["status"],
      detail: step.detail,
    };
  });
  return { options, reasoning };
}

function normalizeInventory(data: unknown): InventoryItem[] {
  if (!Array.isArray(data)) throw new Error("The inventory response was not a list.");

  return data.map((record, index) => {
    if (typeof record !== "object" || record === null) {
      throw new Error(`Inventory record ${index + 1} is invalid.`);
    }

    const item = record as Record<string, unknown>;
    const storeId = optionalNumber(item.storeId);
    const stock = optionalNumber(item.stock);
    const hourlyDemand = optionalNumber(item.hourlyDemand);
    const shelfCapacity = optionalNumber(item.shelfCapacity);
    const product = typeof item.product === "string" ? item.product : "";
    const sku = typeof item.sku === "string" ? item.sku : "";
    if (
      storeId === undefined ||
      stock === undefined ||
      hourlyDemand === undefined ||
      shelfCapacity === undefined ||
      !product ||
      !sku ||
      stock < 0 ||
      hourlyDemand < 0 ||
      shelfCapacity < 0
    ) {
      throw new Error(`Inventory record ${index + 1} is missing valid stock fields.`);
    }

    const category =
      typeof item.category === "string" &&
      ["beverages", "snacks", "sweets", "produce", "essentials", "other"].includes(
        item.category
      )
        ? (item.category as Category)
        : inferCategory(product);

    return {
      storeId,
      storeName:
        typeof item.storeName === "string" ? item.storeName : undefined,
      sku,
      product,
      category,
      stock,
      hourlyDemand,
      shelfCapacity,
      truckArrivalHour: Math.max(0, optionalNumber(item.truckArrivalHour) ?? 4),
      safetyStock: optionalNumber(item.safetyStock),
      unitPrice: optionalNumber(item.unitPrice),
      unitCost: optionalNumber(item.unitCost),
      unitMargin: optionalNumber(item.unitMargin),
      inventorySource:
        typeof item.inventorySource === "string" ? item.inventorySource : undefined,
      verificationStatus:
        typeof item.verificationStatus === "string" ? item.verificationStatus : undefined,
      transferEtaHours: optionalNumber(item.transferEtaHours),
      transportCapacity: optionalNumber(item.transportCapacity),
      earlierTruckAvailable:
        typeof item.earlierTruckAvailable === "boolean"
          ? item.earlierTruckAvailable
          : undefined,
      earlierTruckArrivalHour: optionalNumber(item.earlierTruckArrivalHour),
      earlierTruckUnits: optionalNumber(item.earlierTruckUnits),
      shelfSpaceShareable:
        typeof item.shelfSpaceShareable === "boolean"
          ? item.shelfSpaceShareable
          : undefined,
      source: "backend",
    };
  });
}

function ForecastChart({ item, forecast }: { item: InventoryItem; forecast: Forecast }) {
  const maxStock = Math.max(item.stock, ...forecast.forecast.map((hour) => hour.projectedStock), 1);
  const points = [
    `${18},${82 - (item.stock / maxStock) * 64}`,
    ...forecast.forecast.map(
      (hour, index) =>
        `${48 + index * 44},${82 - (hour.projectedStock / maxStock) * 64}`
    ),
  ].join(" ");

  return (
    <div className="forecast-chart">
      <div className="chart-legend">
        <span><i className="legend-stock" />Projected stock</span>
        <span><i className="legend-demand" />Hourly demand</span>
      </div>
      <svg
        viewBox="0 0 210 110"
        role="img"
        aria-label={`Projected inventory for ${item.product} over four hours`}
      >
        {[1, 2, 3].map((line) => (
          <line key={line} x1="12" x2="198" y1={18 + line * 20} y2={18 + line * 20} className="grid-line" />
        ))}
        <polyline points={points} className="stock-line" />
        {forecast.forecast.map((hour, index) => (
          <g key={hour.hour}>
            <circle
              cx={48 + index * 44}
              cy={82 - (hour.projectedStock / maxStock) * 64}
              r="3.5"
              className="stock-dot"
            />
            <text x={48 + index * 44} y="105" textAnchor="middle" className="chart-label">
              +{hour.hour}h
            </text>
          </g>
        ))}
      </svg>
      <div className="demand-bars" aria-label="Demand by hour">
        {forecast.forecast.map((hour) => (
          <div key={hour.hour} className="demand-bar-wrap">
            <div
              className="demand-bar"
              style={{
                height: `${Math.max(8, Math.min(100, (hour.forecastDemand / Math.max(item.hourlyDemand * 1.4, 1)) * 100))}%`,
              }}
              title={`${hour.forecastDemand} units forecast`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState("Dashboard");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedStore, setSelectedStore] = useState("all");
  const [notice, setNotice] = useState("");
  const [scenario, setScenario] = useState<DemandScenario>("baseline");
  const [scenarioCatalog, setScenarioCatalog] = useState<
    Partial<Record<DemandScenario, ScenarioInfo>>
  >({});
  const [eventStartHour, setEventStartHour] = useState(1);
  const [forecasts, setForecasts] = useState<Record<string, Forecast>>({});
  const [recommendations, setRecommendations] = useState<
    Record<string, ActionRecord | null>
  >({});
  const [actionComparisons, setActionComparisons] = useState<
    Record<string, ActionComparison>
  >({});
  const [actionRecords, setActionRecords] = useState<ActionRecord[]>([]);

  async function loadInventory() {
    setLoading(true);
    setError("");
    try {
      const data = await getInventory();
      const normalized = normalizeInventory(data);
      setInventory(normalized);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Inventory service is unavailable. Inventory data has not been replaced."
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadScenarios() {
    try {
      const result = await getScenarios();
      if (typeof result !== "object" || result === null) {
        throw new Error("The API returned an invalid scenario catalog.");
      }
      const catalog: Partial<Record<DemandScenario, ScenarioInfo>> = {};
      for (const key of ["cricket", "festival", "rain"] as const) {
        const value = (result as Record<string, unknown>)[key];
        if (typeof value !== "object" || value === null) continue;
        const entry = value as Record<string, unknown>;
        if (
          typeof entry.label === "string" &&
          typeof entry.upliftPercent === "number" &&
          Array.isArray(entry.categories) &&
          typeof entry.durationHours === "number" &&
          typeof entry.defaultStartHour === "number" &&
          typeof entry.source === "string"
        ) {
          catalog[key] = {
            label: entry.label,
            upliftPercent: entry.upliftPercent,
            categories: entry.categories.filter(
              (category): category is string => typeof category === "string"
            ),
            durationHours: entry.durationHours,
            defaultStartHour: entry.defaultStartHour,
            source: entry.source,
          };
        }
      }
      setScenarioCatalog(catalog);
    } catch (loadError) {
      setNotice(
        loadError instanceof Error
          ? `Could not load event scenarios: ${loadError.message}`
          : "Could not load configured event scenarios."
      );
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadInventory();
      void loadScenarios();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (inventory.length === 0) {
        setForecasts({});
        setRecommendations({});
        setActionComparisons({});
        setActionRecords([]);
        setForecastLoading(false);
        return;
      }
      const scenarioStart =
        scenario === "baseline"
          ? 1
          : eventStartHour;
      setForecastLoading(true);
      Promise.all(
        inventory.map(async (item) => {
          const [forecastResult, recommendationResult, comparisonResult] = await Promise.all([
            fetchForecast(item.storeId, item.sku, scenario, scenarioStart),
            getRecommendation(item.storeId, item.sku, scenario, scenarioStart),
            fetchActionComparison(item.storeId, item.sku, scenario, scenarioStart),
          ]);
          const forecast = forecastResult as Forecast;
          if (
            !Array.isArray(forecast.forecast) ||
            typeof forecast.expectedShortageBeforeTruck !== "number"
          ) {
            throw new Error(`The forecast response for ${item.sku} is malformed.`);
          }
          const recommendation = recommendationResult as {
            recommendation?: ActionRecord;
            requiresApproval?: boolean;
          };
          const record =
            recommendation.requiresApproval &&
            recommendation.recommendation &&
            typeof recommendation.recommendation.id === "string"
              ? recommendation.recommendation
              : null;
          const comparison = normalizeActionComparison(comparisonResult);
          return {
            key: `${item.storeId}-${item.sku}`,
            forecast,
            record,
            comparison,
          };
        })
      )
        .then(async (results) => {
          const actionsResult = await getActions();
          if (!Array.isArray(actionsResult)) {
            throw new Error("The action history response was malformed.");
          }
          if (cancelled) return;
          setForecasts(
            Object.fromEntries(results.map(({ key, forecast }) => [key, forecast]))
          );
          setRecommendations(
            Object.fromEntries(results.map(({ key, record }) => [key, record]))
          );
          setActionComparisons(
            Object.fromEntries(
              results.map(({ key, comparison }) => [key, comparison])
            )
          );
          setActionRecords(actionsResult as ActionRecord[]);
          setError("");
        })
        .catch((loadError: unknown) => {
          if (cancelled) return;
          setNotice(
            loadError instanceof Error
              ? `Could not load backend forecasts or actions: ${loadError.message}`
              : "Could not load backend forecasts or actions."
          );
        })
        .finally(() => {
          if (!cancelled) setForecastLoading(false);
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inventory, scenario, eventStartHour]);

  const stores = useMemo(
    () =>
      Array.from(
        new Map(
          inventory.map((item) => [
            item.storeId,
            { id: item.storeId, name: storeLabel(item) },
          ])
        ).values()
      ).sort((a, b) => a.id - b.id),
    [inventory]
  );
  const selectedInventory = useMemo(
    () =>
      selectedStore === "all"
        ? inventory
        : inventory.filter((item) => item.storeId === Number(selectedStore)),
    [inventory, selectedStore]
  );
  const stockoutRisks = selectedInventory
    .filter((item) => {
      const forecast = forecasts[`${item.storeId}-${item.sku}`];
      return !!forecast && forecast.expectedShortageBeforeTruck > 0;
    })
    .sort((a, b) => {
      const aTime =
        forecasts[`${a.storeId}-${a.sku}`]?.stockoutInHours ?? Infinity;
      const bTime =
        forecasts[`${b.storeId}-${b.sku}`]?.stockoutInHours ?? Infinity;
      if (aTime !== bTime) return aTime - bTime;
      return (
        (forecasts[`${b.storeId}-${b.sku}`]?.expectedShortageBeforeTruck ?? 0) -
        (forecasts[`${a.storeId}-${a.sku}`]?.expectedShortageBeforeTruck ?? 0)
      );
    });
  const totalUnits = selectedInventory.reduce((sum, item) => sum + item.stock, 0);
  const filteredInventory = selectedInventory.filter((item) => {
    const matchesSearch = `${item.product} ${item.sku} ${item.storeId} ${storeLabel(item)}`
      .toLowerCase()
      .includes(search.toLowerCase());
    const isLow = item.stock <= item.hourlyDemand * 2;
    return matchesSearch && (statusFilter === "all" || (statusFilter === "low" ? isLow : !isLow));
  });
  const financialEstimateSupported =
    stockoutRisks.length > 0 &&
    stockoutRisks.every((item) => item.unitPrice !== undefined);
  const estimatedLostSales = stockoutRisks.reduce(
    (sum, item) =>
      sum +
      (forecasts[`${item.storeId}-${item.sku}`]?.expectedShortageBeforeTruck ?? 0) *
        (item.unitPrice ?? 0),
    0
  );
  const priorityItem = stockoutRisks[0] ?? selectedInventory[0];
  const priorityForecast = priorityItem
    ? forecasts[`${priorityItem.storeId}-${priorityItem.sku}`]
    : undefined;

  function riskActions(item: InventoryItem): ActionOption[] {
    const key = `${item.storeId}-${item.sku}`;
    const forecast = forecasts[key];
    const recommendation = recommendations[key];
    const comparison = actionComparisons[key];
    if (comparison) {
      return comparison.options.map((option) =>
        option.type === "TRANSFER" && recommendation
          ? {
              ...option,
              actionId: recommendation.id,
              sourceAction: recommendation,
            }
          : option
      );
    }
    const transfer = recommendation
      ? {
          title:
            recommendation.action === "TRANSFER"
              ? "Transfer stock from another store"
              : recommendation.action === "WAIT"
                ? "Transfer stock from another store"
                : "Transfer stock from another store",
          feasible: recommendation.feasible,
          quantity: recommendation.quantity,
          reason: recommendation.reason,
          constraints: recommendation.constraints,
          expectedShortage: recommendation.estimatedUnfilledUnitsAfterAction,
          actionId: recommendation.id,
          fromStore: recommendation.fromStore,
          sourceAction: recommendation,
        }
      : {
          title: "Transfer stock from another store",
          feasible: false,
          quantity: 0,
          reason: "Waiting for the backend transfer assessment.",
          constraints: ["Backend feasibility assessment is not available."],
          expectedShortage: forecast?.expectedShortageBeforeTruck ?? 0,
        };
    return [
      transfer,
      {
        title: "Request an earlier truck",
        feasible:
          item.earlierTruckAvailable === true &&
          item.earlierTruckArrivalHour !== undefined &&
          item.earlierTruckUnits !== undefined &&
          item.earlierTruckArrivalHour <
            (forecast?.stockoutInHours ?? Infinity) &&
          item.earlierTruckUnits >=
            (forecast?.expectedShortageBeforeTruck ?? 0),
        quantity: item.earlierTruckUnits ?? 0,
        reason:
          item.earlierTruckAvailable === true
            ? "Backend records an earlier truck option; timing and units are compared with this forecast."
            : "The backend has no confirmed early-delivery plan for this inventory.",
        constraints: [
          ...(item.earlierTruckAvailable === true
            ? []
            : ["Dispatch confirmation of early-truck availability is missing."]),
          ...(item.earlierTruckArrivalHour === undefined
            ? ["Earlier arrival time is missing."]
            : []),
          ...(item.earlierTruckUnits === undefined
            ? ["Confirmed early-truck quantity is missing."]
            : []),
          ...(item.earlierTruckArrivalHour !== undefined &&
          forecast?.stockoutInHours !== null &&
          forecast?.stockoutInHours !== undefined &&
          item.earlierTruckArrivalHour >= forecast.stockoutInHours
            ? ["Earlier delivery arrives after predicted stockout."]
            : []),
          ...(item.earlierTruckUnits !== undefined &&
          forecast &&
          item.earlierTruckUnits < forecast.expectedShortageBeforeTruck
            ? ["Confirmed quantity does not cover the forecast shortage."]
            : []),
        ],
        expectedShortage:
          item.earlierTruckAvailable === true &&
          item.earlierTruckArrivalHour !== undefined &&
          item.earlierTruckArrivalHour <
            (forecast?.stockoutInHours ?? Infinity) &&
          item.earlierTruckUnits !== undefined
            ? Math.max(
                0,
                (forecast?.expectedShortageBeforeTruck ?? 0) -
                  item.earlierTruckUnits
              )
            : forecast?.expectedShortageBeforeTruck ?? 0,
      },
      {
        title: "Reassign shelf space from a slow seller",
        feasible: false,
        quantity: 0,
        reason:
          "Shelf space does not add on-hand units and no slot/dimension data is available.",
        constraints: [
          "Shelf-slot assignment and product dimensions are not configured.",
        ],
        expectedShortage: forecast?.expectedShortageBeforeTruck ?? 0,
      },
      {
        title: "Wait for the scheduled truck",
        feasible: true,
        quantity: 0,
        reason:
          (forecast?.expectedShortageBeforeTruck ?? 0) > 0
            ? `The scheduled truck arrives in ${item.truckArrivalHour}h; the forecast shows ${Math.ceil(forecast?.expectedShortageBeforeTruck ?? 0)} unmet units before arrival.`
            : "Current stock and listed delivery cover forecast demand.",
        constraints: ["No delivery changes or action costs are assumed."],
        expectedShortage: forecast?.expectedShortageBeforeTruck ?? 0,
      },
    ];
  }

  async function handleAddInventory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const storeId = Number(formData.get("storeId"));
    const stock = Number(formData.get("stock"));
    const hourlyDemand = Number(formData.get("hourlyDemand"));
    const shelfCapacity = Number(formData.get("shelfCapacity"));
    const truckArrivalHour = Number(formData.get("truckArrivalHour"));
    const sku = String(formData.get("sku") ?? "").trim();
    const product = String(formData.get("product") ?? "").trim();
    const optionalFormNumber = (key: string) => {
      const value = String(formData.get(key) ?? "").trim();
      return value ? Number(value) : undefined;
    };
    if (
      !Number.isInteger(storeId) ||
      storeId <= 0 ||
      !sku ||
      !product ||
      ![stock, hourlyDemand, shelfCapacity, truckArrivalHour].every(Number.isFinite) ||
      stock < 0 ||
      hourlyDemand < 0 ||
      shelfCapacity < stock ||
      truckArrivalHour < 0
    ) {
      setNotice("Check the new record: store and stock values must be valid, and shelf capacity must cover current stock.");
      return;
    }
    const storeName = String(formData.get("storeName") ?? "").trim() || `Store ${storeId}`;
    const price = Number(formData.get("unitPrice"));
    const cost = Number(formData.get("unitCost"));
    const safetyStock = optionalFormNumber("safetyStock");
    const transferEtaHours = optionalFormNumber("transferEtaHours");
    const transportCapacity = optionalFormNumber("transportCapacity");
    try {
      await postInventory({
        storeId,
        storeName,
        sku,
        product,
        stock,
        hourlyDemand,
        shelfCapacity,
        truckArrivalHour,
        ...(Number.isFinite(price) && price > 0 ? { unitPrice: price } : {}),
        ...(Number.isFinite(cost) && cost > 0 ? { unitCost: cost } : {}),
        ...(safetyStock !== undefined &&
        Number.isInteger(safetyStock) &&
        safetyStock >= 0
          ? { safetyStock }
          : {}),
        ...(transferEtaHours !== undefined &&
        Number.isFinite(transferEtaHours) &&
        transferEtaHours >= 0
          ? { transferEtaHours }
          : {}),
        ...(transportCapacity !== undefined &&
        Number.isInteger(transportCapacity) &&
        transportCapacity >= 0
          ? { transportCapacity }
          : {}),
      });
      setNotice(`Added ${product} at ${storeName} to the backend simulation.`);
      form.reset();
      await loadInventory();
    } catch (addError) {
      setNotice(
        addError instanceof Error
          ? `Could not add inventory: ${addError.message}`
          : "Could not add inventory."
      );
    }
  }

  async function processAction(
    action: ActionRecord,
    status: ApiActionStatus
  ) {
    if (action.status !== "PENDING") return;
    if (status === "APPROVED" && (!action.feasible || action.action !== "TRANSFER")) {
      setNotice(
        "Approval blocked: the backend marks this action as unverified or infeasible."
      );
      return;
    }
    try {
      const result = await updateAction(action.id, status);
      const response = result as { message?: unknown };
      setNotice(
        typeof response.message === "string"
          ? response.message
          : `Action ${status.toLowerCase()} in backend simulation.`
      );
      await loadInventory();
      await refreshActionRecords();
    } catch (actionError) {
      setNotice(
        actionError instanceof Error
          ? `Could not ${status.toLowerCase()} the action: ${actionError.message}`
          : `Could not ${status.toLowerCase()} the action.`
      );
    }
  }

  async function refreshActionRecords() {
    const result = await getActions();
    if (!Array.isArray(result)) {
      throw new Error("The backend returned an invalid action history.");
    }
    setActionRecords(result as ActionRecord[]);
  }

  async function completeSimulatedTransfer(action: ActionRecord) {
    if (action.status !== "APPROVED" || action.action !== "TRANSFER") return;
    try {
      const result = await completeAction(action.id);
      const response = result as { message?: unknown };
      setNotice(
        typeof response.message === "string"
          ? response.message
          : "Transfer completed in simulation; no physical dispatch occurred."
      );
      await loadInventory();
      await refreshActionRecords();
    } catch (completionError) {
      setNotice(
        completionError instanceof Error
          ? `Could not complete simulated transfer: ${completionError.message}`
          : "Could not complete simulated transfer."
      );
    }
  }

  const visibleActionRecords = actionRecords;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark">Z</span>
          <span>zipcart <b>AI</b><small>RETAIL OPERATIONS</small></span>
        </a>
        <p className="side-label">WORKSPACE</p>
        <nav className="nav-list">
          {navigation.map(({ label, icon }) => (
            <button
              key={label}
              className={`nav-item ${page === label ? "active" : ""}`}
              onClick={() => setPage(label)}
              aria-current={page === label ? "page" : undefined}
            >
              <span className="nav-icon" aria-hidden="true">{icon}</span>
              {label}
              {label === "Action Center" && visibleActionRecords.length > 0 && (
                <span className="nav-count">
                  {visibleActionRecords.filter((action) => action.status === "PENDING").length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          <div><strong>Operations workspace</strong><small>Simulation mode</small></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="page-heading">
            <p className="eyebrow">ZIPCART / OPERATIONS</p>
            <h1>{page}</h1>
          </div>
          <div className="header-actions">
            <label className="store-select">
              <span>Store</span>
              <select value={selectedStore} onChange={(event) => setSelectedStore(event.target.value)}>
                <option value="all">All stores</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>{store.name} · {store.id}</option>
                ))}
              </select>
            </label>
            <button className="icon-button" onClick={() => { void loadInventory(); void loadScenarios(); }} disabled={loading} aria-label="Refresh inventory and scenarios">
              <span aria-hidden="true">↻</span>
            </button>
            <div className="profile">
              <span className="avatar" aria-hidden="true">SM</span>
              <div><b>Store Manager</b><small>Demo account</small></div>
            </div>
          </div>
        </header>

        {(error || notice) && (
          <div className={`notice ${error ? "notice-warning" : "notice-success"}`} role="status">
            <span>{error || notice}</span>
            {error && <button className="small-button" onClick={() => { void loadInventory(); void loadScenarios(); }} disabled={loading}>Retry</button>}
            {notice && <button className="notice-close" onClick={() => setNotice("")} aria-label="Dismiss message">×</button>}
          </div>
        )}

        <div className="demo-banner">
          <span className="demo-indicator" />
          <span><strong>Backend simulation</strong> · Actions are simulated — manager approval required; no real dispatch.</span>
        </div>

        {page === "Dashboard" && (
          <>
            <section className="welcome">
              <div>
                <span className="welcome-kicker">OPERATIONS OVERVIEW</span>
                <h2>Good morning, manager</h2>
                <p>Stock health, near-term demand and next-delivery exposure at a glance.</p>
              </div>
              <button className="primary" onClick={() => setPage("Forecast")}>Open 4-hour forecast <span aria-hidden="true">→</span></button>
            </section>
            <section className="stats" aria-label="Inventory key performance indicators">
              <div className="stat-card"><div className="stat-top"><span className="stat-icon blue">▦</span><span className="stat-caption">NETWORK</span></div><p>Stores</p><h2>{loading ? "…" : selectedStore === "all" ? stores.length : 1}</h2><small>Stores in selected view</small></div>
              <div className="stat-card"><div className="stat-top"><span className="stat-icon teal">▤</span><span className="stat-caption">ON HAND</span></div><p>Units in Stock</p><h2>{loading ? "…" : totalUnits.toLocaleString()}</h2><small>Current listed inventory</small></div>
              <div className="stat-card"><div className="stat-top"><span className="stat-icon amber">!</span><span className="stat-caption">NEXT DELIVERY</span></div><p>Predicted Stockouts</p><h2>{loading ? "…" : stockoutRisks.length}</h2><small>Risk before scheduled truck</small></div>
              <div className="stat-card"><div className="stat-top"><span className="stat-icon rose">↗</span><span className="stat-caption">EXPOSURE</span></div><p>Estimated Lost Sales</p><h2>{loading ? "…" : financialEstimateSupported ? formatMoney(estimatedLostSales) : "Not available"}</h2><small>{stockoutRisks.length === 0 ? "No supported loss estimate without a risk" : financialEstimateSupported ? "Estimated revenue exposure, not margin" : "Unit price missing for at least one risk"}</small></div>
            </section>

            <section className="dashboard-grid">
              <div className="panel">
                <div className="panel-heading">
                  <div><h3>Inventory health</h3><p>Current stock relative to shelf capacity</p></div>
                  <span className="data-tag">Backend inputs</span>
                </div>
                {loading ? <p className="empty">Loading inventory…</p> : selectedInventory.length === 0 ? <p className="empty">No inventory records in this store.</p> : (
                  <div className="health-list">
                    {selectedInventory.slice(0, 6).map((item) => {
                      const percent = Math.min(100, (item.stock / Math.max(item.shelfCapacity, 1)) * 100);
                      return <div className="health-row" key={`${item.storeId}-${item.sku}`}>
                        <div className="health-name"><span className="product-dot">{item.product.slice(0, 1).toUpperCase()}</span><div><b>{item.product}</b><small>{storeLabel(item)} · {item.sku}</small></div></div>
                        <div className="health-progress"><div className="progress-track"><span className={percent < 30 ? "progress-low" : ""} style={{ width: `${percent}%` }} /></div><small>{item.stock} / {item.shelfCapacity}</small></div>
                        <span className={`pill ${item.stock <= item.hourlyDemand * 2 ? "pill-warn" : "pill-good"}`}>{item.stock <= item.hourlyDemand * 2 ? "Low" : "Healthy"}</span>
                      </div>;
                    })}
                  </div>
                )}
                <p className="disclaimer">Stock bars are capacity ratios, not sales velocity.</p>
              </div>
              <div className="panel priority-panel">
                <div className="panel-heading"><div><h3>Next 4 Hours</h3><p>Most urgent stockout exposure</p></div><span className="priority-mark">TOP PRIORITY</span></div>
                {!priorityItem || !priorityForecast ? <p className="empty">No stockout risks forecast in this view.</p> : (
                  <>
                    <div className="priority-product"><span className="priority-icon">!</span><div><b>{priorityItem.product}</b><small>{storeLabel(priorityItem)} · {priorityItem.sku}</small></div></div>
                    <div className="priority-metrics">
                      <div><small>Predicted stockout</small><strong>{priorityForecast.stockoutInHours === null ? "Beyond window" : `In ${priorityForecast.stockoutInHours.toFixed(1)}h`}</strong></div>
                      <div><small>Shortage before truck</small><strong>{Math.ceil(priorityForecast.expectedShortageBeforeTruck)} units</strong></div>
                    </div>
                    <p className="priority-note">At {priorityItem.hourlyDemand} baseline units/hour, the scheduled truck is in {priorityItem.truckArrivalHour}h. Demand uses hourly inputs.</p>
                    <button className="text-button" onClick={() => setPage("Recommendations")}>Review response options <span aria-hidden="true">→</span></button>
                  </>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading"><div><h3>Priority queue</h3><p>Ranked by time to stockout, then shortage size</p></div><button className="small-button" onClick={() => setPage("Forecast")}>View forecast</button></div>
              {stockoutRisks.length === 0 ? <p className="empty">{loading ? "Checking inventory…" : "No stockout before delivery detected under the current assumptions."}</p> : (
                <div className="table-scroll"><table><thead><tr><th>Priority</th><th>Product / store</th><th>Stockout</th><th>Truck ETA</th><th>Shortage</th><th>Confidence</th></tr></thead><tbody>
                  {stockoutRisks.slice(0, 5).map((item, index) => {
                    const forecast = forecasts[`${item.storeId}-${item.sku}`]!;
                    return <tr key={`${item.storeId}-${item.sku}`}><td><span className={`rank-badge ${index === 0 ? "rank-first" : ""}`}>{String(index + 1).padStart(2, "0")}</span></td><td><b>{item.product}</b><small className="cell-sub">{storeLabel(item)} · {item.sku}</small></td><td>{forecast.stockoutInHours === null ? "> 4h" : `${forecast.stockoutInHours.toFixed(1)}h`}</td><td>{item.truckArrivalHour}h</td><td><span className="pill pill-warn">{Math.ceil(forecast.expectedShortageBeforeTruck)} units</span></td><td><span className="confidence-label">{forecast.scenario.dataQuality}</span></td></tr>;
                  })}
                </tbody></table></div>
              )}
            </section>
          </>
        )}

        {page === "Inventory" && (
          <>
            <section className="panel">
              <div className="panel-heading"><div><h3>Store inventory</h3><p>Search, filter, and review stock, sales rate and shelf capacity.</p></div><button className="secondary-button" onClick={() => void loadInventory()} disabled={loading}>Refresh data</button></div>
              <div className="inventory-tools">
                <label className="search-field"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product, SKU or store…" aria-label="Search inventory" /></label>
                <label className="filter-field"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All items</option><option value="low">Low stock</option><option value="healthy">Healthy</option></select></label>
                <span className="record-count">{filteredInventory.length} records</span>
              </div>
              <div className="table-scroll"><table><thead><tr><th>Store</th><th>Product</th><th>SKU</th><th>Stock</th><th>Demand / hour</th><th>Shelf capacity</th><th>Truck ETA</th><th>Status</th></tr></thead><tbody>
                {filteredInventory.map((item) => <tr key={`${item.storeId}-${item.sku}`}><td>{storeLabel(item)} <small className="cell-sub">#{item.storeId}</small></td><td><b>{item.product}</b><small className="cell-sub">{item.category} · {item.verificationStatus || "verification unavailable"}</small></td><td>{item.sku}</td><td><b>{item.stock}</b></td><td>{item.hourlyDemand}</td><td>{item.shelfCapacity}</td><td>{item.truckArrivalHour}h</td><td><span className={`pill ${item.stock <= item.hourlyDemand * 2 ? "pill-warn" : "pill-good"}`}>{item.stock <= item.hourlyDemand * 2 ? "Low stock" : "Healthy"}</span></td></tr>)}
              </tbody></table></div>
              {filteredInventory.length === 0 && <p className="empty">No items match the current search and filter.</p>}
              <p className="disclaimer">Data source is labelled per row set. Demand is treated as units per hour, never daily sales.</p>
            </section>
            <section className="panel">
              <div className="panel-heading"><div><h3>Add product or store inventory</h3><p>Create a local simulation record for an existing or new store.</p></div><span className="data-tag assumption-tag">Local simulation</span></div>
              <form className="add-form" onSubmit={handleAddInventory}>
                <label>Store ID<input name="storeId" type="number" min="1" step="1" required placeholder="e.g. 12" /></label>
                <label>Store name<input name="storeName" placeholder="e.g. Central" /></label>
                <label>Product<input name="product" required placeholder="Product name" /></label>
                <label>SKU<input name="sku" required placeholder="e.g. JUICE-1L" /></label>
                <label>Stock<input name="stock" type="number" min="0" step="1" required /></label>
                <label>Demand / hour<input name="hourlyDemand" type="number" min="0" step="any" required /></label>
                <label>Shelf capacity<input name="shelfCapacity" type="number" min="0" step="1" required /></label>
                <label>Truck ETA (hours)<input name="truckArrivalHour" type="number" min="0" step="any" required defaultValue="4" /></label>
                <label>Unit price (optional)<input name="unitPrice" type="number" min="0" step="any" placeholder="INR" /></label>
                <label>Unit cost (optional)<input name="unitCost" type="number" min="0" step="any" placeholder="INR" /></label>
                <label>Safety stock (optional)<input name="safetyStock" type="number" min="0" step="1" /></label>
                <label>Transfer ETA (hours, optional)<input name="transferEtaHours" type="number" min="0" step="any" /></label>
                <label>Transport capacity (optional)<input name="transportCapacity" type="number" min="0" step="1" /></label>
                <button className="primary" type="submit">Add to simulation</button>
              </form>
            </section>
          </>
        )}

        {page === "Stores" && <StoreMap onActionsChanged={() => void refreshActionRecords()} />}

        {page === "Forecast" && (
          <>
            <section className="panel scenario-panel">
              <div className="panel-heading"><div><h3>Event scenario simulator</h3><p>Choose a backend-configured event; uplift applies only to its configured categories and hours.</p></div><span className="data-tag assumption-tag">Configured scenario inputs</span></div>
              <div className="scenario-controls">
                <div className="scenario-options" role="group" aria-label="Demand scenario">
                  {(["baseline", "cricket", "festival", "rain"] as DemandScenario[]).filter((option) => option === "baseline" || scenarioCatalog[option]).map((option) => (
                    <button key={option} className={`scenario-chip ${scenario === option ? "selected" : ""}`} onClick={() => {
                      setScenario(option);
                      if (option !== "baseline") {
                        setEventStartHour(scenarioCatalog[option]?.defaultStartHour ?? 1);
                      }
                    }} aria-pressed={scenario === option}>
                      {option === "baseline" ? "Baseline" : scenarioCatalog[option]?.label ?? option}
                    </button>
                  ))}
                </div>
                {scenario !== "baseline" && scenarioCatalog[scenario] && <label className="filter-field"><span>Event starts</span><select value={eventStartHour} onChange={(event) => setEventStartHour(Number(event.target.value))}>{[1, 2, 3, 4].map((hour) => <option key={hour} value={hour}>Hour {hour}</option>)}</select></label>}
              </div>
              {scenario !== "baseline" && scenarioCatalog[scenario] && <p className="scenario-explainer"><strong>{scenarioCatalog[scenario].label}:</strong> baseline demand × {(1 + scenarioCatalog[scenario].upliftPercent / 100).toFixed(2)} ({scenarioCatalog[scenario].upliftPercent}% uplift), only for {scenarioCatalog[scenario].categories.join(", ")} during hours {eventStartHour}–{eventStartHour + scenarioCatalog[scenario].durationHours - 1}. {scenarioCatalog[scenario].source}. No unrelated scenario effects are compounded.</p>}
              {Object.keys(scenarioCatalog).length === 0 && <p className="disclaimer">Scenario configuration is unavailable. Retry the backend to load supported event scenarios.</p>}
              <p className="disclaimer">Scenario configuration is provided by the backend. The cricket match uses its configured 200% uplift (baseline × 3), which is an illustrative existing scenario value, not a measured forecast.</p>
            </section>
            {forecastLoading && <section className="panel"><p className="empty">Loading authoritative backend forecasts…</p></section>}
            {stockoutRisks.length === 0 && selectedInventory.length > 0 && !forecastLoading && <section className="panel empty-state"><span className="success-mark">✓</span><h3>No projected shortage before the next truck</h3><p>Backend hourly demand and selected event assumptions fit listed inventory.</p></section>}
            {selectedInventory.filter((item) => forecasts[`${item.storeId}-${item.sku}`]).map((item) => {
              const forecast = forecasts[`${item.storeId}-${item.sku}`];
              const riskLevel = forecast.expectedShortageBeforeTruck <= 0 ? "Covered" : forecast.stockoutInHours !== null && forecast.stockoutInHours < 2 ? "High risk" : "At risk";
              return <section className="panel forecast-panel" key={`${item.storeId}-${item.sku}`}>
                <div className="panel-heading forecast-heading"><div><div className="title-line"><h3>{item.product}</h3><span className={`pill ${forecast.expectedShortageBeforeTruck ? "pill-warn" : "pill-good"}`}>{riskLevel}</span></div><p>{storeLabel(item)} · {item.sku} · Backend inventory</p></div><div className="forecast-current"><small>Current stock</small><strong>{item.stock} <span>units</span></strong></div></div>
                <div className="forecast-summary">
                  <div><small>Predicted stockout</small><b>{forecast.stockoutInHours === null ? "None in 4h" : `Hour ${forecast.stockoutInHours.toFixed(1)}`}</b></div>
                  <div><small>Shortage before truck ({forecast.truckArrivalHour}h)</small><b className={forecast.expectedShortageBeforeTruck ? "text-danger" : ""}>{Math.ceil(forecast.expectedShortageBeforeTruck)} units</b></div>
                  <div><small>Expected demand before truck</small><b>{forecast.demandBeforeTruck.toFixed(1)} units</b></div>
                  <div><small>Confidence / quality</small><b>{forecast.scenario.dataQuality}</b></div>
                </div>
                <div className="forecast-content">
                  <ForecastChart item={item} forecast={forecast} />
                  <div className="hourly-list">
                    <div className="hourly-head"><span>HOUR</span><span>FORECAST DEMAND</span><span>PROJECTED STOCK</span></div>
                    {forecast.forecast.map((hour) => <div className="hourly-row" key={hour.hour}><b>+{hour.hour}h</b><span>{hour.forecastDemand.toFixed(1)} units{hour.upliftPercent > 0 ? ` · +${hour.upliftPercent}%` : ""}{hour.scheduledDelivery > 0 ? ` · +${hour.scheduledDelivery} delivery` : ""}</span><span className={hour.estimatedUnfilledDemand > 0 ? "text-danger" : ""}>{hour.projectedStock} units{hour.estimatedUnfilledDemand > 0 ? ` · ${hour.estimatedUnfilledDemand.toFixed(1)} unmet` : ""}</span></div>)}
                  </div>
                </div>
                <p className="disclaimer">Projection floors displayed stock at zero; the backend reports unmet demand separately. Demand is hourly. Truck quantity is not available unless a simulated delivery is explicitly scheduled.</p>
              </section>;
            })}
            <section className="diagnosis-panel"><span className="diagnosis-icon">↗</span><div><b>Bottleneck diagnosis</b><p>The current backend inventory does not include donor safety stock, rider availability, transfer ETA, truck capacity, or truck arrival quantities. These are logistics and data-quality constraints separate from the measured on-hand stock.</p></div></section>
          </>
        )}

        {page === "Recommendations" && (
          <>
            <section className="panel">
              <div className="panel-heading"><div><h3>Action comparison</h3><p>Compare feasible moves against waiting for each current risk.</p></div><span className="data-tag">Rule-based decision support</span></div>
              {forecastLoading && <p className="empty">Loading backend recommendations…</p>}
              {stockoutRisks.length === 0 ? <p className="empty">{selectedInventory.length === 0 ? "Inventory is not available. Check the backend connection." : "No current stockout risks to compare."}</p> : stockoutRisks.map((item) => {
                const forecast = forecasts[`${item.storeId}-${item.sku}`];
                const actions = riskActions(item);
                const best = actions.find((action) => action.feasible && action.title !== "Wait for the scheduled truck");
                return <article className="risk-comparison" key={`${item.storeId}-${item.sku}`}>
                  <div className="risk-title"><div><h4>{item.product} <span>· {storeLabel(item)}</span></h4><p>{item.stock} in stock · {item.hourlyDemand} baseline units/hour · truck in {item.truckArrivalHour}h</p></div><span className="pill pill-warn">{Math.ceil(forecast?.expectedShortageBeforeTruck ?? 0)} units at risk</span></div>
                  <div className="action-grid">
                    {actions.map((action) => <div className={`action-option ${action.feasible ? "option-feasible" : "option-unverified"}`} key={`${item.sku}-${action.title}`}>
                      <div className="option-top"><b>{action.title}</b><span className={`pill ${action.feasible ? "pill-good" : "pill-muted"}`}>{action.actionId ? action.feasible ? "Backend checked" : "Backend unverified" : action.title === "Wait for the scheduled truck" ? "Compare baseline" : action.feasible ? "Feasible · confirm" : "Unverified"}</span></div>
                      <p>{action.reason}</p>
                      <dl><div><dt>Expected shortage</dt><dd>{Math.ceil(action.expectedShortage)} units</dd></div><div><dt>Lost sales / margin</dt><dd>{item.unitPrice === undefined ? "Revenue unavailable" : `${formatMoney(Math.ceil(action.expectedShortage) * item.unitPrice)} revenue`}{item.unitMargin === undefined ? " · margin unavailable" : ` · ${formatMoney(Math.ceil(action.expectedShortage) * item.unitMargin)} margin`}</dd></div><div><dt>Action cost</dt><dd>{action.cost === undefined ? "Cost data unavailable" : formatMoney(action.cost)}</dd></div></dl>
                      {action.quantity > 0 && <p className="quantity-note">Proposed quantity: <strong>{action.quantity} units</strong>{action.fromStore !== undefined && action.fromStore !== null && <> · Source: Store {action.fromStore}</>}</p>}
                      {action.constraints.length > 0 && <p className="constraint-note">{action.constraints.join(" ")}</p>}
                    </div>)}
                  </div>
                  <div className="counterfactual"><span className="counterfactual-icon">↔</span><p><b>Counterfactual:</b> If we wait, {Math.ceil(forecast?.expectedShortageBeforeTruck ?? 0)} units are short before arrival{item.unitPrice === undefined ? "" : ` (up to ${formatMoney(Math.ceil(forecast?.expectedShortageBeforeTruck ?? 0) * item.unitPrice)} sales revenue exposure, not margin)`}. {best ? `Backend-verified ${best.title.toLowerCase()} leaves ${Math.ceil(best.expectedShortage)} units exposed.` : "No transfer is verifiably feasible with current backend data; remaining risk requires manager intervention."}</p></div>
                  <div className="why-panel"><b>Why this recommendation?</b><p>{item.stock} current units − {(forecast?.demandBeforeTruck ?? 0).toFixed(1)} projected demand before truck = {Math.max(0, item.stock - (forecast?.demandBeforeTruck ?? 0)).toFixed(1)} physical units remaining before applicable deliveries, with {Math.ceil(forecast?.expectedShortageBeforeTruck ?? 0)} units of rounded unmet demand. {best ? `${best.title} passed backend donor/shelf/timing constraints.` : "No action is recommended: donor safety stock, transfer timing, rider capacity, or shelf constraints are missing or fail validation."}</p></div>
                  {actionComparisons[`${item.storeId}-${item.sku}`] && <div className="agent-reasoning"><b>Deterministic agent reasoning</b><ol>{actionComparisons[`${item.storeId}-${item.sku}`].reasoning.map((step) => <li key={step.step} className={`reasoning-${step.status}`}><span>{step.status.replace("_", " ")}</span><div><strong>{step.step}</strong><small>{step.detail}</small></div></li>)}</ol></div>}
                </article>;
              })}
              <p className="disclaimer">Prices are only used when supplied by the backend and represent estimated lost sales revenue, not margin or savings. Unknown action costs stay unknown.</p>
            </section>
            <section className="panel opportunity-panel">
              <div className="panel-heading"><div><h3>Shelf-space opportunity</h3><p>Slow sellers can free shelf capacity, but cannot fix shortages without stock and shelf data.</p></div><span className="data-tag assumption-tag">Not verified</span></div>
              <p className="empty">Shelf-slot assignments, product dimensions and shareable-space constraints are not available from the backend. No shelf swap is recommended.</p>
            </section>
          </>
        )}

        {page === "Action Center" && (
          <section className="panel">
            <div className="panel-heading"><div><h3>Manager approval queue</h3><p>Validate proposed actions before changing simulated stock or delivery plans.</p></div><span className="data-tag assumption-tag">Simulation only · no real dispatch</span></div>
            <div className="action-tabs">
              {(["PENDING", "APPROVED", "REJECTED", "COMPLETED"] as const).map((status) => <div className={`action-tab ${status.toLowerCase()}`} key={status}><span>{status.charAt(0) + status.slice(1).toLowerCase()}</span><b>{visibleActionRecords.filter((record) => record.status === status).length}</b></div>)}
            </div>
            {visibleActionRecords.length === 0 ? <p className="empty">No current risks require review.</p> : visibleActionRecords.map((record) => {
              const pending = record.status === "PENDING";
              const title = record.action === "TRANSFER" ? "Transfer stock from another store" : record.action === "WAIT" ? "Wait for the scheduled truck" : "Transfer review required";
              const impact = record.action === "TRANSFER" ? `${record.estimatedUnfilledUnitsAfterAction} shortage units remain after the proposed transfer.` : `${record.requiredQuantity} shortage units remain under the current forecast.`;
              return <article className="approval-card" key={record.id}>
                <div className="approval-heading"><div><span className={`pill ${record.status === "APPROVED" || record.status === "COMPLETED" ? "pill-good" : record.status === "REJECTED" ? "pill-muted" : "pill-warn"}`}>{record.status}</span><h4>{record.product} <span>· Store {record.storeId}</span></h4></div><span className="approval-quantity">{record.quantity} <small>units</small></span></div>
                <div className="approval-details"><div><small>Proposed action</small><b>{title}</b></div><div><small>Reason</small><b>{record.reason}</b></div><div><small>Estimated impact</small><b>{impact}</b></div><div><small>Constraints</small><b>{record.constraints.join(" ") || "All listed backend checks passed."}</b></div></div>
                {pending && <div className="approval-controls"><span>{record.feasible && record.action === "TRANSFER" ? "Backend checks pass; approval revalidates the plan. Inventory is not moved until you complete the simulation." : "Unverified — approval remains disabled until required backend data is available."}</span><div><button className="approve-button" disabled={!record.feasible || record.action !== "TRANSFER"} onClick={() => void processAction(record, "APPROVED")}>Approve plan</button><button className="reject-button" onClick={() => void processAction(record, "REJECTED")}>Reject</button></div></div>}
                {record.status === "APPROVED" && record.action === "TRANSFER" && <div className="approval-controls"><span>Approved plan only. Completing this step updates simulated inventory; it does not dispatch a vehicle.</span><button className="approve-button" onClick={() => void completeSimulatedTransfer(record)}>Complete simulated transfer</button></div>}
              </article>;
            })}
            <p className="disclaimer">Approval records a plan after backend validation; simulated inventory changes only when the manager selects Complete simulated transfer. Rejection records the decision and leaves inventory unchanged. No physical transfer is initiated.</p>
          </section>
        )}

        <footer>Zipcart AI <span>·</span> Retail operations decision support <span>·</span> All unconnected operations are simulations</footer>
      </main>
    </div>
  );
}
