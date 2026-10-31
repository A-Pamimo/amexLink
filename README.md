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
| `AUTH_MODE` | no | `required` \| `none` | default `required`; `none` is refused in production (see [Authentication](#authentication)) |
| `APP_ORIGIN` | yes when `required` | origin URL | exact browser origin, e.g. `http://localhost:3000`; must be `https://` in production |
| `AUTH_SETUP_TOKEN` | first run | ≥ 32 chars | consulted only while no sign-in factor is enrolled |
| `COOKIE_INSECURE_DEV` | no | `0` \| `1` | `1` drops `__Host-`/`Secure` for plain-http LAN testing; refused in production |
| `TOKEN_ENCRYPTION_KEY` | yes (at server start) | base64 of 32 bytes | AES-256-GCM data key; see [Encryption key](#encryption-key) |
| `TOKEN_ENCRYPTION_KEY_FILE` | alternative | path | `0600` file holding the base64 key or 32 raw bytes, outside `data/` |

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

## Authentication

There is no password. The owner signs in with a **passkey** (WebAuthn, user verification required) or a **TOTP** authenticator app, and keeps **10 single-use recovery codes** for device loss. Factors are enrolled at runtime, not chosen by env (`docs/SECURITY.md` 3.3).

**First run (setup flow)**

1. Put a random `AUTH_SETUP_TOKEN` (≥ 32 chars, e.g. `openssl rand -base64 32`) and the exact `APP_ORIGIN` in `.env.local`, start the server, open `/login`.
2. Paste the setup token → scan the TOTP QR code → enter one code. The server stores the secret encrypted (AES-256-GCM, AAD `auth_state:totp`) and marks it enrolled only after that code verifies.
3. Save the 10 recovery codes (shown once, stored as hashes).
4. Optionally add a passkey. More passkeys and new recovery codes can be added later under **Settings → Sign-in and sessions**.

The setup token is consulted **only while zero factors are enrolled**; afterwards it is dead, and every enrolment needs a signed-in session. Rotate or delete it once set up.

**Sessions and cookies**

- 256-bit random token in a cookie named `__Host-amexlens_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`). The database stores only its SHA-256.
- Absolute lifetime 12 h, idle timeout 2 h. The token is rotated on sign-in, on linking a card and on disconnecting one.
- **Sign out** deletes the server row, so any other copy of the cookie dies. **Sign out everywhere** deletes every row.
- Sign-in locks for 15 minutes after 5 failures (global counter, not per IP: `X-Forwarded-For` is spoofable and there is one user). The counter is in memory and resets on restart.
- Every state-changing request must come from `APP_ORIGIN` (`Origin`/`Referer` check) and carry the `X-AmexLens-Request: 1` header (`lib/client/api.ts` adds it). Otherwise `403 { error: { code: "csrf" } }`.
- `middleware.ts` only redirects browsers without a token-shaped cookie to `/login` (API calls get `401` JSON). The real check is `requireSession` / `requireMutation` as the first statement of every handler, so a middleware bypass changes nothing.

**`AUTH_MODE=none`** disables all of this. It exists for local sandbox work and the test suite; the server refuses to start with it in production, and also refuses `COOKIE_INSECURE_DEV=1` or an `http://` `APP_ORIGIN` in production.

`/api/health` is reachable without a session so external monitors don't need credentials.

## Plaid sync flow

1. `POST /api/plaid/link-token` → server creates a Link token (products: `transactions`, country codes from env).
2. Client opens Plaid Link via `usePlaidLink`. On success, posts the `public_token` + institution metadata to `POST /api/plaid/exchange`.
3. Server exchanges for an `access_token`, stores the item, and triggers an initial sync.
4. `POST /api/plaid/sync[?item_id=...]` runs `/transactions/sync` in a `has_more` loop:
   - **added** → `INSERT OR IGNORE`, auto-categorized via `lib/categorize.ts`.
   - **modified** → `UPDATE`, but `bucket` is overwritten **only if `bucket_override = 0`** (your manual overrides survive re-syncs).
   - **removed** → hard `DELETE`.
   - `cursor` + `last_synced_at` are persisted only on a fully successful loop.

Manual sync lives on `/settings` (per-card and "Sync all"). For cron, hit it via:

```bash
npm run sync                                # uses BASE_URL=http://127.0.0.1:3000
BASE_URL=https://your-host npm run sync
```

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
  login/page.tsx                   first-run setup (TOTP, recovery codes, passkey) and sign-in
  api/
    plaid/{link-token,exchange,sync}/route.ts
    items/[id]/route.ts            disconnect a card
    items/route.ts                 list cards
    transactions/{[id],}/route.ts  list / patch / reset bucket
    stats/{totals,trend}/route.ts  aggregations
    auth/status                    which factors exist (public, no secrets)
    auth/setup/{totp/start,totp/confirm,passkey/options,passkey/verify,recovery}
    auth/login/{totp,passkey/options,passkey/verify,recovery}
    auth/logout, auth/sessions     delete this session / every session
    health/route.ts                always-public status
components/                        SWR-driven client UI (AuthSettings.tsx = factors, sign out)
lib/
  auth/                            session.ts (requireSession, rotate), guard.ts (requireMutation, CSRF),
                                   totp.ts, passkey.ts, recovery.ts, lockout.ts, cookie.ts, from.ts
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
  transactions.ts                  /transactions/sync loop
  date.ts, format.ts, id.ts        small helpers
middleware.ts                      cookie-shape gate (redirect / 401); handlers do the real check
scripts/sync.mjs                   cron-friendly sync trigger
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
| `npm run sync` | hits `/api/plaid/sync` on the running server; loads `.env.local` via `--env-file-if-exists`. Needs a session or the WP4 `CRON_SECRET`; the old `AUTH_PASSWORD` path is gone |
| `npm run backup` | copies the sqlite file to `data/backups/amexlens-<timestamp>.sqlite`; loads `.env.local` |
| `npm run key:generate` | prints a fresh `TOKEN_ENCRYPTION_KEY=<base64 32 bytes>` line (see [Encryption key](#encryption-key)) |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, test, `npm audit --audit-level=high` and build on every PR.

## Verification

A full local smoke test:

1. `cp .env.example .env.local`, fill sandbox creds, `APP_ORIGIN=http://localhost:3000`, a 32+ char `AUTH_SETUP_TOKEN`, and `npm run key:generate >> .env.local`. Open `/login` and complete the setup flow (or set `AUTH_MODE=none` for a throwaway sandbox).
2. `npm install && npm run dev`.
3. `/settings` → Connect → sandbox login (`user_good` / `pass_good`).
4. `sqlite3 data/amexlens.sqlite '.tables'` shows `_migrations`, `plaid_items`, `transactions`. `SELECT COUNT(*) FROM transactions;` is non-zero.
5. `/` shows the donut + 6-month trend; `/transactions` populates.
6. Override a row's bucket → refresh → override sticks. Click **Sync all** on `/settings` → override still sticks (validates the `bucket_override` guard).
7. Click **reset** on the overridden row → it returns to the categorizer's choice.
8. Link a second sandbox item → the **All cards** filter chip appears in the nav; selecting one scopes the dashboard.
9. `curl http://localhost:3000/api/stats/totals?from=2026-04-01&to=2026-04-30` returns `{ from, to, byBucket, grandTotal }`.
10. `curl -i http://127.0.0.1:3000/api/items` → `401` JSON; `curl -i http://127.0.0.1:3000/transactions` → `307` to `/login?from=%2Ftransactions`; `curl -H 'Cookie: amexlens_auth=ok' http://127.0.0.1:3000/api/items` → `401`; `/api/health` still answers.

## Known limitations

- A pending → posted transition (Plaid emits `removed(pending_id)` + `added(posted_id)`) drops any manual override on the pending row. v2 could rehydrate by hashing `(date, amount, merchant_name)`.
- libsql + postgres drivers are stubbed; the interface is ready, the driver files are not.
- Single owner only: one TOTP secret, one WebAuthn user handle, one set of recovery codes. No account recovery beyond those codes (lose them all and you reset the `auth_state`/`passkeys`/`recovery_codes` tables by hand and run setup again).
- The sign-in lockout counter lives in process memory and resets on restart.
- No multi-currency rollup with FX yet — each transaction stores its own `iso_currency_code` so totals can mix currencies if you link both USD and CAD cards. The dashboard formats per-row and doesn't try to convert.

## License

Personal project, no license file. Treat as all rights reserved unless you add one.
