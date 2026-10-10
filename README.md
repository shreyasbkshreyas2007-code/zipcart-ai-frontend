# Zipcart AI operations dashboard

This is the existing Next.js 16 / React 19 operations frontend. It calls the
existing Express service; it does not connect directly to PostgreSQL or hold
database credentials. Inventory, forecast, recommendation, map, nearby-store,
and action data are requested through `app/api.ts`.

## Run the frontend

1. Copy `.env.example` to `.env.local` and keep the local API URL:

   ```env
   NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3000
   ```

2. Install dependencies and run the existing app on port 3001:

   ```powershell
   npm install
   npm run dev -- --port 3001
   ```

3. Open `http://localhost:3001`.

## Store map and data labels

The Stores page uses Leaflet with OpenStreetMap tiles and attribution. Public
OSM locations are possible retail locations, not verified Zipcart stores.
Store details show **Inventory unavailable** when no operational inventory is
associated. JSON demo stores have no coordinates and therefore are not plotted.
The nearby search uses straight-line Haversine distance, not driving distance.

## Backend and database setup

See the [backend README](../zipcart-backend/README.md) for Express, Supabase
PostgreSQL, database migration/seed, OpenStreetMap import, API, and test
instructions. When `DATABASE_URL` is absent, the backend uses its explicitly
labelled persistent JSON demo data. No frontend change silently replaces a
failed API response with local sample inventory.

## Checks

```powershell
npm run lint
npx tsc --noEmit
npm run build
```
