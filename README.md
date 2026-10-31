# AmexLens

A self-hosted personal-finance dashboard for Plaid-linked cards (Amex or otherwise). Connect a card, sync transactions, see them auto-categorized into spending buckets, override categories where the auto-rules miss, and watch a monthly stacked trend.

Next.js 15 (App Router, React 19) + Tailwind + SQLite (or libsql / Postgres) + Plaid + Recharts + SWR.

## Quick start

```bash
git clone <repo>
cd amexLink
nvm use                           # Node 22 (see .nvmrc; engines >=22.12 <23)
cp .env.example .env.local        # fill in PLAID_CLIENT_ID / PLAID_SECRET
npm install
npm run dev                       # http://127.0.0.1:3000 (bound to loopback only)
```

Open `/settings` → **Connect a card** → in Plaid sandbox use:

- username: `user_good`
- password: `pass_good`
- MFA (if prompted): `1234`

Sandbox seeds ~50–200 transactions; the dashboard, donut, and trend chart populate immediately.

## Environment variables

All live in `.env.local` (gitignored). `.env.example` documents the full surface.

| var | required | values | notes |
|---|---|---|---|
| `PLAID_CLIENT_ID` | yes | string | from the Plaid dashboard |
| `PLAID_SECRET` | yes | string | scoped per env (sandbox/development/production) |
| `PLAID_ENV` | no | `sandbox` \| `development` \| `production` | default `sandbox` |
| `PLAID_COUNTRY_CODES` | no | comma list | default `US,CA` |
| `STORAGE` | no | `sqlite` \| `libsql` \| `postgres` | default `sqlite` |
| `DB_PATH` | no | path | sqlite only; default `data/amexlens.sqlite` |
| `DATABASE_URL` | conditional | URL | required for `libsql` / `postgres` |
| `AUTH_MODE` | no | `none` \| `password` \| `passkey` | default `none` |
| `AUTH_PASSWORD` | conditional | string | required when `AUTH_MODE=password` |
| `TOKEN_ENCRYPTION_KEY` | yes (at server start) | base64 of 32 bytes | AES-256-GCM data key; see [Encryption key](#encryption-key) |
| `TOKEN_ENCRYPTION_KEY_FILE` | alternative | path | `0600` file holding the base64 key or 32 raw bytes, outside `data/` |
| `CRON_SECRET` | no | string, >= 32 chars | bearer secret for `npm run sync` (see [Cron](#cron)); the server refuses to start if it is set but shorter |

Validation runs at server startup (`lib/env.ts`). Missing or invalid values throw a clear error before anything tries to talk to Plaid or the DB.

### Encryption key

Aggregator access tokens are stored encrypted (AES-256-GCM, `lib/crypto.ts`) under one 32-byte data key.

- **Generate:** `npm run key:generate` prints a `TOKEN_ENCRYPTION_KEY=...` line (the reminder goes to stderr, so `npm run key:generate >> .env.local` appends only the key).
- **Store:** in a password manager, and in `.env.local` (mode `0600`) or a `0600` file referenced by `TOKEN_ENCRYPTION_KEY_FILE`. Never in `data/`, never in backups, never in git. The key must not live in the same copy as the database, or a copied `data/` folder is a token leak.
- **Without it:** the server refuses to start (`lib/boot.ts` → `loadDataKey()`); there is no plaintext fallback. A key that is not exactly 32 bytes is also refused. `next build` does not need the key.
- **If you lose it:** the stored tokens cannot be decrypted. Delete the affected items and re-link every card. Ciphertext is prefixed with a key version (`v1.`) so a later rotation can decrypt with the old key and re-encrypt with the new one.

## Storage modes

You can pick the storage backend per deploy:

- **`sqlite`** (default) — `better-sqlite3` against a local file. Fast, zero ops, perfect for localhost / homelab / a small VPS. Native module, so it does **not** run on Vercel serverless.
- **`libsql`** — Turso / libsql remote. Vercel-compatible. Driver slot exists in `lib/db.ts`; add `@libsql/client` and implement `lib/db/libsql.ts` against the same `DB` interface as `lib/db/sqlite.ts`.
- **`postgres`** — same story, slot is wired but the driver isn't installed by default.

The `DB` interface in `lib/db.ts` is the single source of truth — every API route and helper goes through it, so swapping drivers is mechanical.

## Auth modes

- **`none`** (default) — open. Fine for `localhost`.
- **`password`** — single shared password set via `AUTH_PASSWORD`. `middleware.ts` redirects to `/login` and sets a `httpOnly` cookie on success. Use this when reaching the app over Tailscale / LAN.
- **`passkey`** — slot reserved; not implemented yet. Add `@simplewebauthn/server` and wire up `/api/auth/*` to ship.

`/api/health` is always reachable so external monitors don't need credentials. It answers `{ "ok": true }` (or `{ "ok": false }` with HTTP 503) and nothing else. Operator detail (storage, Plaid env, auth mode, country codes, counts) lives in `GET /api/system`, which is meant to sit behind the session once auth lands.

## Plaid sync flow

1. `POST /api/plaid/link-token` → server creates a Link token (products: `transactions`, country codes from env).
2. Client opens Plaid Link via `usePlaidLink`. On success, posts only the `public_token` to `POST /api/plaid/exchange` (rate limited, 10/h; link-token is also 10/h).
3. Server exchanges for an `access_token`, **stores the item immediately** (a duplicate `item_id` revokes the new token and returns 409 `already_linked`), takes institution id/name from Plaid (`itemGet` + `institutionsGetById`, never from the browser), then triggers an initial sync. A failed first sync does not fail the link: the response is HTTP 200 with `sync: { ok: false, code }`.
4. `POST /api/plaid/sync[?item_id=...]` runs `/transactions/sync` in a `has_more` loop:
   - **added** → `INSERT OR IGNORE`, auto-categorized via `lib/categorize.ts`.
   - **modified** → `UPDATE`, but `bucket` is overwritten **only if `bucket_override = 0`** (your manual overrides survive re-syncs).
   - **removed** → hard `DELETE`.
   - Each page is applied in one DB transaction; the Plaid call itself is never inside one.
   - `cursor` + `last_synced_at` are persisted only after the full loop, by compare-and-set against the cursor the sync started from (a concurrent writer is never overwritten; `sync_cursor_conflict` is logged instead). Syncs of one item are serialised in-process.
   - `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts the loop from the starting cursor (max 3 attempts).
   - `ITEM_LOGIN_REQUIRED` marks the item `needs_relink`; "Sync all" continues past a failing card and reports each card's result.

Manual sync lives on `/settings` (per-card and "Sync all"), limited to 6/hour per card.

### Cron

`scripts/sync.mjs` posts to `/api/plaid/sync` with `Authorization: Bearer $CRON_SECRET`. It refuses to run without `CRON_SECRET`, defaults to `BASE_URL=http://127.0.0.1:3000`, refuses a non-loopback `BASE_URL` unless you pass `--allow-remote`, and prints counts and short codes only (exit 2 if any card failed). The secret is only accepted in the header, never in a query string.

```bash
openssl rand -base64 32                     # put the result in .env.local as CRON_SECRET=...
npm run sync                                # loads .env.local; BASE_URL=http://127.0.0.1:3000
# crontab: 17 6 * * *  cd /path/to/amexLink && npm run sync >> sync.log 2>&1
```

### Item status

`GET /api/items` returns `status` and `last_error` (a provider error code only) per card:

| status | meaning | what to do |
|---|---|---|
| `active` | syncing normally | nothing |
| `needs_relink` | Plaid reports the login is no longer valid (`ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN`) | re-link the card; a later successful sync returns it to `active` |
| `consent_required` | Plaid needs additional consent (`ADDITIONAL_CONSENT_REQUIRED`) | re-consent via Link |
| `revoke_failed` | Disconnect could not be confirmed by Plaid; the local row and token are kept | click **Retry revoke** on `/settings` |

Disconnect revokes at Plaid first and deletes locally only after Plaid accepts (or says the item is already gone).

## Categories ("buckets")

`lib/categorize.ts` runs three tiers, in order:

1. Exact match against Plaid's detailed `personal_finance_category` (e.g. `FOOD_AND_DRINK_RESTAURANTS` → `food`).
2. Merchant-name regex (e.g. `netflix|spotify|hulu` → `subscriptions`, with a Canadian-leaning grocery / telco list).
3. Lowercased substring sniff on the detailed category, falling back to `other`.

Buckets are: `food`, `groceries`, `travel`, `transport`, `utilities`, `subscriptions`, `shopping`, `health`, `entertainment`, `education`, `income`, `transfers`, `other`. `income` and `transfers` are hidden from the donut + trend chart by default; the **Include income & transfers** toggle on the dashboard / transactions page reveals them.

To override a category, click the bucket chip in the transactions table and pick a new one. That sets `bucket_override = 1`. Click **reset** on a row to clear the override and re-run the categorizer.

## Project layout

```
app/
  page.tsx                         dashboard
  transactions/page.tsx            filterable table + override
  settings/page.tsx                items, sync, system status
  login/page.tsx                   used when AUTH_MODE=password
  api/
    plaid/{link-token,exchange,sync}/route.ts
    items/[id]/route.ts            disconnect a card
    items/route.ts                 list cards
    transactions/{[id],}/route.ts  list / patch / reset bucket
    stats/{totals,trend}/route.ts  aggregations
    auth/{login,logout}/route.ts   password mode endpoints
    health/route.ts                always-public { ok } probe
    system/route.ts                operator detail (storage, env, counts)
components/                        SWR-driven client UI
lib/
  types.ts                         BucketKey, Transaction, etc.
  categorize.ts                    Plaid -> bucket rules
  env.ts                           validated env loader
  db.ts                            DB interface (ItemsRepo + TransactionsRepo + StatsRepo + CoreRepo) + driver dispatch
  db/sqlite/index.ts               opens the DB, runs migrations, composes the repos
  db/sqlite/{items,transactions,stats,core}.ts   per-area better-sqlite3 repos
  db/migrations/                   NNNN_name.sql files plus code steps in index.ts
  audit.ts                         security_log writer
  boot.ts                          startup config checks (called from instrumentation.ts)
  client/api.ts                    browser fetch wrapper (apiFetch, ApiError)
  plaid.ts                         PlaidApi factory
  transactions.ts                  /transactions/sync loop (per-item lock, cursor CAS, SyncError)
  sync/{lock,authorize}.ts         per-item mutex; CRON_SECRET bearer check for /api/plaid/sync
  items/revoke.ts                  revoke-then-delete
  http/{errors,params,rate-limit,log-shim}.ts   safe error bodies, query parsing, in-process rate limits
  date.ts, format.ts, id.ts        small helpers
middleware.ts                      auth gate
scripts/sync.mjs                   cron-friendly sync trigger (CRON_SECRET bearer)
scripts/backup.mjs                 copies sqlite to data/backups/
test/                              vitest suites, helpers (loadApp, plaid-fake) and fixtures
instrumentation.ts                 runs assertBootConfig() when the server starts
```

## Scripts

| command | what it does |
|---|---|
| `npm run dev` | Next dev server on `127.0.0.1:3000` (`-H 127.0.0.1`) |
| `npm run build` / `npm start` | production build + start (`start` also binds `127.0.0.1`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint flat config (`eslint.config.mjs`, `eslint-config-next`) |
| `npm test` / `npm run test:watch` | vitest (node env, temp SQLite file per test; see `test/helpers/`) |
| `npm run sync` | hits `/api/plaid/sync` on the running server with `Authorization: Bearer $CRON_SECRET` (see [Cron](#cron)); loads `.env.local` via `--env-file-if-exists` |
| `npm run backup` | copies the sqlite file to `data/backups/amexlens-<timestamp>.sqlite`; loads `.env.local` |
| `npm run key:generate` | prints a fresh `TOKEN_ENCRYPTION_KEY=<base64 32 bytes>` line (see [Encryption key](#encryption-key)) |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, test, `npm audit --audit-level=high` and build on every PR.

## Verification

A full local smoke test:

1. `cp .env.example .env.local`, fill sandbox creds, leave `STORAGE=sqlite` and `AUTH_MODE=none`.
2. `npm install && npm run dev`.
3. `/settings` → Connect → sandbox login (`user_good` / `pass_good`).
4. `sqlite3 data/amexlens.sqlite '.tables'` shows `_migrations`, `plaid_items`, `transactions`. `SELECT COUNT(*) FROM transactions;` is non-zero.
5. `/` shows the donut + 6-month trend; `/transactions` populates.
6. Override a row's bucket → refresh → override sticks. Click **Sync all** on `/settings` → override still sticks (validates the `bucket_override` guard).
7. Click **reset** on the overridden row → it returns to the categorizer's choice.
8. Link a second sandbox item → the **All cards** filter chip appears in the nav; selecting one scopes the dashboard.
9. `curl http://localhost:3000/api/stats/totals?from=2026-04-01&to=2026-04-30` returns `{ from, to, byBucket, grandTotal }`.
10. Switch `AUTH_MODE=password` + set `AUTH_PASSWORD`, restart, confirm `/login` is enforced and `/api/health` is still open (and returns only `{"ok":true}`).

## Known limitations

- A pending → posted transition (Plaid emits `removed(pending_id)` + `added(posted_id)`) drops any manual override on the pending row. v2 could rehydrate by hashing `(date, amount, merchant_name)`.
- libsql + postgres drivers are stubbed; the interface is ready, the driver files are not.
- Passkey auth is reserved but not implemented.
- No multi-currency rollup with FX yet — each transaction stores its own `iso_currency_code` so totals can mix currencies if you link both USD and CAD cards. The dashboard formats per-row and doesn't try to convert.

## License

Personal project, no license file. Treat as all rights reserved unless you add one.
