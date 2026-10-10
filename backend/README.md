# Zipcart AI Express backend

The existing Express API on port `3000` remains the only trusted application
API. The Next.js frontend must never receive PostgreSQL credentials.

## Current architecture and modes

- `app.js` retains the existing inventory, hourly forecast, recommendation,
  action, and simulated-delivery contracts.
- With `DATABASE_URL` configured, PostgreSQL is the source of truth for the
  relational stores, products, inventory, hourly sales, events, warehouse
  stock, trucks, riders, and actions. API errors are surfaced; the service
  does not silently fall back to JSON.
- Without `DATABASE_URL`, the existing `data.json` is used as persistent,
  simulated demo data. Existing inventory and action history are not reset on
  server startup. Demo locations deliberately have no coordinates.
- Public OSM records describe real mapped retail locations only. They do not
  verify store ownership, product stock, or Zipcart operations.

## Supabase PostgreSQL configuration

1. Create a Supabase project and obtain its PostgreSQL connection string from
   **Project Settings → Database → Connection string**. A session pooler
   connection string is suitable where direct IPv6 connectivity is unavailable.
2. Copy `.env.example` to `.env` in this backend folder. Set a server-side
   `DATABASE_URL` and `PG_SSL=true`; never place this connection string or a
   service-role key in a `NEXT_PUBLIC_` variable or the frontend folder.
3. Keep `FRONTEND_ORIGINS=http://localhost:3001` for local development. Add
   only exact, intentionally configured origins for other deployments.
4. Apply schema and preserve/import the existing JSON data:

   ```powershell
   npm install
   npm run migrate
   npm run seed
   ```

   The migration runner is repeatable. The seed inserts the existing
   `data.json` records with `ON CONFLICT DO NOTHING`; it does not truncate,
   clear, or overwrite existing database rows. Run the seed before the OSM
   importer so the legacy numeric store IDs are reserved.
5. Start the backend:

   ```powershell
   npm start
   ```

   Check `http://127.0.0.1:3000/health`. PostgreSQL mode reports unavailable
   migrations as an error rather than serving JSON data.

`.env.example` contains placeholders only. Do not commit a populated `.env`.
The frontend's existing `.env.local` should contain only:

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3000
```

## Schema and public store import

`migrations/001_initial.sql` creates the normalized tables and indexes:
`stores`, `products`, `inventory`, `hourly_sales`, `warehouse_inventory`,
`trucks`, `truck_deliveries`, `events`, `riders`, `actions`, and
`demo_deliveries`. Coordinate range checks are enforced in PostgreSQL. The
schema uses ordinary latitude/longitude rather than PostGIS; nearby search
uses the Haversine formula and reports straight-line distance.

With migrations and the seed complete, the optional Bengaluru demonstration
import runs once against the public Overpass API:

```powershell
npm run import:osm
```

It requests mapped supermarkets, convenience shops, greengrocers, and
department stores in the configured Bengaluru bounding box. It uses actual
source coordinates and stable OSM element IDs, deduplicates by source ID, and
upserts repeat imports. Unnamed or coordinate-less elements are omitted rather
than assigned invented names or locations. Imported rows are marked
`unverified` and `store_type` records the OSM `shop` value; they are **not**
declared Zipcart-owned or stocked. The map and imported data require internet
access to Overpass and OpenStreetMap tiles. Follow the
[Overpass API usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API)
and retain the visible `© OpenStreetMap contributors` attribution.

## Data quality and calculations

- Seeded inventory and its baseline hourly demand are explicitly simulated.
- Forecasting uses an average of hourly sales from the last 28 days only when
  at least three hourly records exist; otherwise the API reports its
  simulated/unverified baseline assumption.
- Event uplifts apply only to matching product categories and overlapping
  forecast hours. When multiple uplifts overlap, the greatest applicable
  uplift is used instead of multiplying unrelated effects. The existing
  cricket/festival/rain scenarios remain illustrative assumptions.
- Forecast physical stock is floored at zero; unmet demand is returned
  separately. Known scheduled SKU deliveries are applied once.
- Transfer recommendations require destination shelf headroom, donor safety
  stock, donor-demand coverage through the donor's next scheduled delivery,
  a transfer ETA before the target stockout, configured transport capacity,
  coordinates, and inventory updated within the last 24 hours. Missing or
  stale inputs result in an unverified recommendation. These constraints do
  not establish driving distance or actual dispatch availability.
- Product selling price and unit cost support estimated lost-sales revenue and
  gross margin when provided. Unknown action/delivery cost remains unavailable.
- Simulated approvals lock action and inventory rows in a database transaction,
  revalidate constraints, and update stock and action history atomically.
  Rejections update action status only. No real dispatch is initiated.

## API routes

Existing routes:

- `GET /health`, `GET /api/inventory`, `POST /api/inventory`
- `GET /api/inventory/:storeId/:sku`
- `GET /api/scenarios`
- `GET /api/forecast/:storeId/:sku`
- `GET /api/recommendations/:storeId/:sku`
- `GET /api/action-comparison/:storeId/:sku`
- `GET /api/actions`, `POST /api/actions/:actionId`
- `GET /api/deliveries`, `POST /api/deliveries`

Additional PostgreSQL-backed routes:

- `GET /api/stores`, `GET /api/stores/:storeId`
- `GET /api/stores/nearby?latitude=...&longitude=...&radiusKm=...`
- `GET,POST /api/hourly-sales`, `GET,POST /api/events`
- `GET /api/warehouse-inventory`, `GET /api/trucks`, `GET /api/riders`

In JSON mode, those additional routes return explicitly labelled empty or
simulated records where the existing JSON file has no corresponding data.

## Run and test both apps

Backend, from `C:\Users\suman\zipcart-backend`:

```powershell
npm install
npm test
npm start
```

Frontend, from `C:\Users\suman\Downloads\zipcart-ai-frontend`:

```powershell
npm install
npm run dev -- --port 3001
```

Then open `http://localhost:3001`. Frontend validation:

```powershell
npm run lint
npx tsc --noEmit
npm run build
```

## Safe demo-data handling and limitations

- No reset script is provided. Do not delete or truncate database tables to
  "reset" a demo. Back up data first and make targeted, reviewed edits using
  SQL or an authorized application workflow.
- Do not edit `data.json` while the JSON backend is running; stop it first so
  persisted state is not overwritten on a later API mutation.
- No Supabase credentials were available during implementation, so database
  migrations, PostgreSQL queries/transactions, OSM database import, and
  persistence across PostgreSQL restarts still require execution in a
  configured Supabase project.
- Hourly sales, actual prices/costs, actual event feeds, warehouse stock,
  delivery quantities/capacity, rider availability, verified transfer
  logistics, authentication, and manager identity are not supplied by the
  existing project. The schema/API provides integration surfaces; empty or
  simulated values are not represented as live operational facts.
- The OSM import is explicit and optional. It was not run against a database
  in the current environment.
