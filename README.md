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
| `BACKUP_AGE_RECIPIENT` | for `npm run backup` | `age1...` public key | backups are encrypted to it; see [Backups and restore drill](#backups-and-restore-drill) |
| `AGE_IDENTITY_FILE` | for `npm run restore:check` only | path | age identity (private key). Only on the machine running the restore drill, never on the server |

Validation runs at server startup (`lib/env.ts`). Missing or invalid values throw a clear error before anything tries to talk to Plaid or the DB.

### Encryption key

Aggregator access tokens are stored encrypted (AES-256-GCM, `lib/crypto.ts`) under one 32-byte data key.

- **Generate:** `npm run key:generate` prints a `TOKEN_ENCRYPTION_KEY=...` line (the reminder goes to stderr, so `npm run key:generate >> .env.local` appends only the key).
- **Store:** in a password manager, and in `.env.local` (mode `0600`) or a `0600` file referenced by `TOKEN_ENCRYPTION_KEY_FILE`. Never in `data/`, never in backups, never in git. The key must not live in the same copy as the database, or a copied `data/` folder is a token leak.
- **Without it:** the server refuses to start (`lib/boot.ts` → `loadDataKey()`); there is no plaintext fallback. A key that is not exactly 32 bytes is also refused. `next build` does not need the key.
- **If you lose it:** the stored tokens cannot be decrypted. Delete the affected items and re-link every card. Ciphertext is prefixed with a key version (`v1.`) so a later rotation can decrypt with the old key and re-encrypt with the new one.
- **At rest:** tokens live in `plaid_items.access_token_ct` only (migration `0004 token_ct` moved them there, dropped the plaintext column, ran `VACUUM` and wrote a `token_migration` row to `security_log`). A row that no longer decrypts raises `TokenUnreadableError` and is logged as `token_decrypt_failed` with the item id only; the card must be re-linked. The DB directory is forced to `0700` and the DB/WAL/SHM files to `0600` on every open.
- **After upgrading an existing install:** old backups under `data/backups/*.sqlite` still contain plaintext tokens. Destroy them (`npm run backup -- --purge-plaintext`) and run `npm run verify:no-plaintext`, which exits 1 if any file under `data/` still contains a Plaid token prefix.

### Host disk encryption

Full-disk encryption on the host is required. If the host is a VPS and SQLCipher is not used, a snapshot of the running disk exposes transaction and liability text. Token ciphertext stays safe in that case only because the data key is not in the same copy; keep `TOKEN_ENCRYPTION_KEY` out of `data/`, out of backups and out of any cloud-synced folder.

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

`/api/health` is always reachable so external monitors don't need credentials.

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
  login/page.tsx                   used when AUTH_MODE=password
  api/
    plaid/{link-token,exchange,sync}/route.ts
    items/[id]/route.ts            disconnect a card
    items/route.ts                 list cards
    transactions/{[id],}/route.ts  list / patch / reset bucket
    stats/{totals,trend}/route.ts  aggregations
    auth/{login,logout}/route.ts   password mode endpoints
    health/route.ts                always-public status
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
  log.ts                           JSON-line logger + redact() (tokens, secrets, cookies, Plaid error bodies)
  errors.ts                        TokenUnreadableError (token ciphertext cannot be opened -> re-link)
  crypto.ts                        AES-256-GCM data key core
  boot.ts                          startup config checks (called from instrumentation.ts)
  client/api.ts                    browser fetch wrapper (apiFetch, ApiError)
  plaid.ts                         PlaidApi factory
  transactions.ts                  /transactions/sync loop
  date.ts, format.ts, id.ts        small helpers
middleware.ts                      auth gate
scripts/sync.mjs                   cron-friendly sync trigger
scripts/backup.mjs                 consistent snapshot -> age-encrypted data/backups/*.sqlite.age
scripts/restore-check.mjs          decrypts a backup to a temp file and opens it read-only (restore drill)
scripts/verify-no-plaintext.mjs    scans data/ for plaintext Plaid token prefixes
scripts/log.mjs                    JSON-line logger for the scripts (mirror of lib/log.ts)
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
| `npm run sync` | hits `/api/plaid/sync` on the running server (auths if `AUTH_PASSWORD` is set); loads `.env.local` via `--env-file-if-exists` |
| `npm run backup` | consistent snapshot of the DB, age-encrypted to `BACKUP_AGE_RECIPIENT`, written to `data/backups/amexlens-<timestamp>.sqlite.age` (mode `0600`, newest 7 kept); `-- --purge-plaintext` also deletes legacy `*.sqlite` backups; refuses to run without a recipient; loads `.env.local` |
| `npm run restore:check -- <file.age>` | restore drill: decrypts with `AGE_IDENTITY_FILE` to a temp file, opens read-only, prints migration ids + item count, deletes the temp |
| `npm run verify:no-plaintext [-- <dir>]` | exits 1 (listing file names) if any file under `data/` contains `access-sandbox-`/`access-development-`/`access-production-` |
| `npm run key:generate` | prints a fresh `TOKEN_ENCRYPTION_KEY=<base64 32 bytes>` line (see [Encryption key](#encryption-key)) |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, test, `npm audit --audit-level=high` and build on every PR.

## Backups and restore drill

Backups are consistent SQLite snapshots (better-sqlite3 online backup API, correct under WAL) encrypted to an [age](https://age-encryption.org) public key before they touch disk. The snapshot still contains the token ciphertext and all transaction rows, so the plaintext temp file is deleted in a `finally` and only the `.age` file (mode `0600`) remains.

**One-time setup (on your laptop, not on the server):**

```bash
age-keygen -o amexlens-backup.key          # prints "Public key: age1..."
chmod 600 amexlens-backup.key
```

- Put the **public key** in the server's `.env.local` as `BACKUP_AGE_RECIPIENT=age1...`.
- Keep the **identity file** (`amexlens-backup.key`, the private key) in your password manager and on the machine where you run restore drills. It must not be on the server, under `data/`, or in any folder a cloud-sync tool uploads. The backup job never reads it.
- Keep `TOKEN_ENCRYPTION_KEY` separate from the backups too: a backup plus the data key equals every token.

**Taking backups:** `npm run backup` (cron it alongside `npm run sync`). The newest 7 `.age` files are kept (`BACKUP_KEEP` to change); output dir is `data/backups/` (`BACKUP_DIR` to change). The script refuses to run without `BACKUP_AGE_RECIPIENT`, so a misconfigured cron cannot write a plaintext copy.

**Restore drill (run once after setup and after any upgrade):**

1. Copy the newest `data/backups/amexlens-<stamp>.sqlite.age` to the machine that holds the identity.
2. `AGE_IDENTITY_FILE=./amexlens-backup.key npm run restore:check -- amexlens-<stamp>.sqlite.age`
3. Expect a line like `migrations=1,2,4 items=<n> integrity=ok`. The script decrypts to a `0600` temp file, opens it read-only, prints only those markers, and deletes the temp file.
4. To actually restore: stop the app first (WAL), decrypt with `age -d -i amexlens-backup.key -o data/amexlens.sqlite <file>.age`, remove any stale `data/amexlens.sqlite-wal` / `-shm`, `chmod 600` the file, start the app. Never overwrite a live DB.

**After the token migration (existing installs):** backups taken before WP3 are plaintext and contain access tokens. Run `npm run backup -- --purge-plaintext` to delete `data/backups/*.sqlite`, destroy any copies elsewhere, then `npm run verify:no-plaintext` to confirm no Plaid token prefix remains under `data/`.

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
10. Switch `AUTH_MODE=password` + set `AUTH_PASSWORD`, restart, confirm `/login` is enforced and `/api/health` is still open.

## Known limitations

- A pending → posted transition (Plaid emits `removed(pending_id)` + `added(posted_id)`) drops any manual override on the pending row. v2 could rehydrate by hashing `(date, amount, merchant_name)`.
- libsql + postgres drivers are stubbed; the interface is ready, the driver files are not.
- Passkey auth is reserved but not implemented.
- No multi-currency rollup with FX yet — each transaction stores its own `iso_currency_code` so totals can mix currencies if you link both USD and CAD cards. The dashboard formats per-row and doesn't try to convert.

## License

Personal project, no license file. Treat as all rights reserved unless you add one.
