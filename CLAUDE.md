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
- **Sets become Shopify bundles**: a Pauly set is a single-variant product whose page groups separate pieces (`select[data-groups-pr-sl]`, one per piece) and whose cart charges the pieces. The scraper resolves those pieces (`components`) and sets the set's base to the sum of their prices; `set-bundles.server.ts` turns the store product into a bundle of the pieces already synced (one "Talla <piece>" option per piece, Shopify derives stock) and only rebuilds it when the pieces change. Bundle products are updated without options, variants or inventory, and their generated variants are never deleted as orphans. Sets whose page shows a single piece stay as regular products.

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

## User-Agent configuration

Both HTTP scrape paths against `paulylingerie.com` (the `/products.json` pagination loop and the per-product `/products/{handle}` HTML fetch inside `performSingleAttempt`) send a desktop browser User-Agent header sourced from a single module-level pool. The pool is read from `process.env.PAULY_USER_AGENT` exactly once at module load in `app/services/scraper.server.ts`; the env is never re-read inside the request loop, and both call sites consume the same `pickUserAgent()` helper.

- **Env var name**: `PAULY_USER_AGENT`
- **Default (env unset)**: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36` — names Chrome major version 148 (current stable at implementation time). The previous hardcoded value named Chrome 91 from May 2021, which is the kind of stale UA that WAFs increasingly reject — and Cloudflare in front of paulylingerie.com is precisely the class of WAF that will throw 429/403 at an outdated browser fingerprint.
- **Pool syntax**: a comma-separated list of full User-Agent strings. Each entry is trimmed; empty entries are dropped. When the pool has 2+ entries, one is picked per request via `Math.random()`. When the pool has exactly 1 entry, that entry is used for every request.
- **Empty-as-disabled escape hatch**: setting the env var to an empty string, only whitespace, or only commas parses to a zero-length pool. In that case both fetch call sites **omit the `User-Agent` header entirely** from their headers object (the runtime sends no UA to the source). This escape hatch is the operator's last-resort lever if a future UA also starts getting WAF-blocked — toggleable via Secret Manager without a code change.

The 429/408 retry classification in `performSingleAttempt` (Retry-After honor, [2000, 8000] ms backoff) is unaffected by this configuration: it operates on the response status independent of which UA was sent.

### Operator examples

Set a single UA via Secret Manager (recommended for production rotation):

```bash
echo -n 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' \
  | gcloud secrets versions add PAULY_USER_AGENT --data-file=-
```

Set a comma-separated pool of two UAs:

```bash
echo -n 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36,Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' \
  | gcloud secrets versions add PAULY_USER_AGENT --data-file=-
```

Disable the User-Agent header entirely (escape hatch):

```bash
echo -n '' | gcloud secrets versions add PAULY_USER_AGENT --data-file=-
```

After adding a new secret version, redeploy or restart the Cloud Run revision so it picks up the new value (the pool is computed at module load, not per request).

## Cloud Scheduler configuration

Cloud Scheduler jobs targeting this app's `/cron` endpoint MUST be configured with `maxRetryAttempts=0` (preferred) or `maxRetryAttempts=1` (maximum acceptable). The default Cloud Scheduler retry policy retries on 5xx responses and is INCORRECT for this endpoint.

A `/cron` request that times out partway through has still successfully DISPATCHED the bulk operation to Shopify (the dispatch is fire-and-forget). A retry would either (i) fail with "another bulk operation is currently running for this shop" because the original op is still in-flight, or (ii) in the narrow window between Shopify accepting the dispatch and the in-progress flag becoming visible, dispatch a duplicate concurrent sync — which is silently expensive and racy. The terminal SyncLog state is written asynchronously by the `bulk_operations/finish` webhook handler (`app/routes/webhooks.bulk-operations.finish.tsx`), so a timeout on the dispatching request does NOT imply the sync failed — only that the HTTP layer gave up waiting on the scrape.

Example `gcloud` command to create a correctly-configured scheduler job:

```bash
gcloud scheduler jobs create http pauly-sync \
  --schedule='0 * * * *' \
  --uri='https://<your-cloud-run-url>/cron?token=<CRON_TOKEN>&shop=<your-shop>.myshopify.com' \
  --http-method=GET \
  --max-retry-attempts=0 \
  --location=us-central1
```

This setting is an OPERATOR responsibility in the GCP console or `gcloud` CLI when the Cloud Scheduler job is first created or edited. The code does NOT enforce `maxRetryAttempts<=1`; the contract is documentary. Future hardening (e.g. a per-shop lock in the SyncLog table that rejects duplicate dispatches at the application layer) is out of scope for this brief.

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

### Async sync via webhook (BRIEF-024 amendment R1)

- `/cron` is fire-and-forget — returns 200 immediately after bulk operations are dispatched to Shopify, without waiting for Shopify-side processing to complete
- Terminal SyncLog state (`running` -> `completed`/`failed`/`partial`) is written by the new `app/routes/webhooks.bulk-operations.finish.tsx` webhook handler, which receives Shopify's `bulk_operations/finish` webhook topic
- Cloud Run timeout bumped from 300s to 3600s to accommodate the post-patch-8ce0d8c scrape duration (~9m26s for 444 products with 250ms inter-fetch Cloudflare-mitigation delay)
- Cloud Scheduler `maxRetryAttempts` MUST be <= 1 — see the [Cloud Scheduler configuration](#cloud-scheduler-configuration) section above for rationale and setup instructions
