# scrapping-pauly

Web scraping tool and Shopify sync app for paulylingerie.com (same stack as scrapping-nina/scrapping-bacoa).

## Pauly-specific differences vs the base template

- **Identity**: `custom.pauly_ref = String(product.id)` from /products.json. No `extractRefFromHandle` regex.
- **Title**: verbatim from /products.json on CREATE. No placeholder title healing, no `PLACEHOLDER_TITLE_REGEX`. UPDATE path never overwrites title.
- **Color**: no color extraction from product titles. Each color variant is a separate product in the source.
- **Vendor**: literal `"Pauly"` on CREATE only. UPDATE path omits vendor (merchant-owned post-creation).
- **Price factor**: `PAULY_PRICE_BASE_FACTOR` env var (default 1.0 when unset/empty/NaN). The `custom.cambio_precio_base` metafield value = `scraped_base_price * factor`.
- **Multi-tenant chokepoint**: `fetchAllShopifyProducts` filters by `metafields.custom.pauly_ref:*` — ensures no cross-tenant interference with scrapping-bacoa products on the same destination store.
- **SKU prefix**: `PAULY-` instead of the base template's prefix.

## Stack
- Remix 2 + Vite + TypeScript
- React 18 + Shopify Polaris
- Prisma + MySQL
- Cheerio (DOM scraping)
- Shopify App Bridge

## Scripts
- `npm run dev` — development server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript type checking

## Structure
- `app/routes/` — Remix file-based routing
- `app/services/` — Business logic (scraping, sync)
- `app/db.server.ts` — Prisma singleton instance
- `app/shopify.server.ts` — Shopify app initialization
- `app/root.tsx` — Root layout

## Patterns
- Server-only files: .server.ts suffix
- Path alias: ~/* maps to ./app/*
- Remix loaders/actions for server state
- useFetcher for client mutations
- Shopify Polaris components
- Cheerio for HTML parsing
- Prisma global singleton pattern
- TypeScript strict mode
- 2-space indentation, semicolons

## Operator notes

- This repo is bound to a SEPARATE Shopify app from scrapping-bacoa. The app is registered in Partners with `client_id = 1ad019feac52ea36b9f3ec08efc7efda`. Do NOT run `shopify app init` or `shopify app config link` — the binding is via `shopify.app.scrapping-pauly.toml`. Use `shopify app dev` for local development.
- The HTML scrape timeout override is `PAULY_HTML_FETCH_TIMEOUT_MS` (default 10000 ms when unset/malformed).
- Test backfill and migration scripts via `shopify app dev` tunnel locally before deploying to Cloud Run. Cloud Run services auto-create on first deploy via `google-github-actions/deploy-cloudrun@v2` — no manual pre-creation needed.
- Prisma migrations must be committed in `prisma/migrations/` before the first deploy. The deploy workflow runs `npx prisma migrate deploy` as a Cloud Run job after each deployment.

## Known issues

- **InMotion Prisma migrate-deploy**: the MySQL instance on InMotion hosting may require `--skip-generate` flag or a direct `prisma db push` if the Cloud Run migration job fails due to SSL/connection timeouts against InMotion's MySQL. Workaround: run `npx prisma migrate deploy` from a local machine with direct DB access, then deploy the app separately.

## Changelog

### Bootstrap (BRIEF-024) — initial implementation

Initial bootstrap of scrapping-pauly, modeled on the post-BRIEF-023 architecture of the base scraping template with pauly-specific adaptations:

- Source: paulylingerie.com (~450 products on Shopify+Kalles theme)
- `custom.pauly_ref` metafield as canonical identity (`String(product.id)`)
- Env-driven `PAULY_PRICE_BASE_FACTOR` (default 1.0) for wholesale margin tuning
- Title verbatim from /products.json (no HTML title scrape, no placeholder healing)
- No color extraction from product titles
- Virgin-tenant first sync: all products created as DRAFT
- Separate Shopify app and Session DB (multi-tenant safety)
- Multi-tenant chokepoint via `fetchAllShopifyProducts` filtered by `metafields.custom.pauly_ref:*`
