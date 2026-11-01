# AmexLens

A self-hosted, single-owner overview of ALL your credit cards, built on Plaid. The home screen shows each card's balance, statement balance, limit, utilization, minimum payment, due date, last payment, APRs and overdue flag, sorted by what is due soonest, with totals per currency. Every field comes from the aggregation API or is shown as missing with the reason; there is no manual entry. The spending dashboard (auto-categorized transactions, manual category overrides, monthly stacked trend) lives at `/spending`.

Next.js 15 (App Router, React 19) + Tailwind + SQLite + Plaid + Recharts + SWR. Sign-in is a passkey or an authenticator-app code with recovery codes; Plaid tokens are encrypted at rest. Start with `HANDOVER.md` for the project state, `docs/SECURITY.md` for the security bar and `docs/ARCHITECTURE.md` for the design.

## Quick start

```bash
git clone <repo>
cd amexLink
nvm use                           # Node 22 (see .nvmrc; engines >=22.12 <23)
cp .env.example .env.local        # fill in PLAID_CLIENT_ID / PLAID_SECRET (sandbox keys)
npm run key:generate              # prints TOKEN_ENCRYPTION_KEY=...; paste it over the empty line in .env.local (required to start)
# edit .env.local: APP_ORIGIN=http://localhost:3000, AUTH_SETUP_TOKEN=<32+ random chars, e.g. openssl rand -base64 32>
npm ci
npm run dev                       # http://localhost:3000 (the server binds 127.0.0.1 only)
```

Open the exact `APP_ORIGIN` in the browser (a different host name fails the CSRF origin check), then:

1. **`/login` first-run setup.** Paste `AUTH_SETUP_TOKEN`, scan the TOTP QR code with an authenticator app, enter one code, and save the 10 recovery codes (shown once). Optionally add a passkey (it needs a hostname origin such as `localhost`, not a bare IP address). Details in [Authentication](#authentication).
2. **Connect a card.** `/settings` → **Connect a card**. In Plaid sandbox use username `user_good`, password `pass_good`, MFA (if prompted) `1234`.
3. `/` is the cards overview; `/spending` is the spending dashboard, populated by the sandbox's ~50 to 200 transactions.

For a throwaway sandbox you can skip setup with `AUTH_MODE=none`; the server refuses it in production.

## Environment variables

All live in `.env.local` (gitignored). `.env.example` documents the full surface; the last three rows are read by the scripts, not by `lib/env.ts`. `PLAID_ENV` also picks the Plaid API host in the CSP `connect-src` (see [Security headers](#security-headers)).

| var | required | values | notes |
|---|---|---|---|
| `PLAID_CLIENT_ID` | yes | string | from the Plaid dashboard |
| `PLAID_SECRET` | yes | string | scoped per env (sandbox/development/production) |
| `PLAID_ENV` | no | `sandbox` \| `development` \| `production` | default `sandbox` |
| `PLAID_COUNTRY_CODES` | no | comma list | default `CA` (this owner is in Canada); set `US,CA` explicitly for a US-issued card |
| `STORAGE` | no | `sqlite` \| `libsql` \| `postgres` | default `sqlite` |
| `DB_PATH` | no | path | sqlite only; default `data/amexlens.sqlite` |
| `DATABASE_URL` | conditional | URL | required for `libsql` / `postgres` |
| `AUTH_MODE` | no | `required` \| `none` | default `required`; `none` is refused in production (see [Authentication](#authentication)) |
| `APP_ORIGIN` | yes when `required` | origin URL | exact browser origin, e.g. `http://localhost:3000`; must be `https://` in production |
| `AUTH_SETUP_TOKEN` | first run | ≥ 32 chars | consulted only while no sign-in factor is enrolled |
| `COOKIE_INSECURE_DEV` | no | `0` \| `1` | `1` drops `__Host-`/`Secure` (cookie `amexlens_session`) for plain-http LAN testing; refused when `PLAID_ENV=production` |
| `TOKEN_ENCRYPTION_KEY` | yes (at server start) | base64 of 32 bytes | AES-256-GCM data key; see [Encryption key](#encryption-key) |
| `TOKEN_ENCRYPTION_KEY_FILE` | alternative | path | `0600` file holding the base64 key or 32 raw bytes, outside `data/` |
| `BACKUP_AGE_RECIPIENT` | for `npm run backup` | `age1...` public key | backups are encrypted to it; see [Backups and restore drill](#backups-and-restore-drill) |
| `AGE_IDENTITY_FILE` | for `npm run restore:check` only | path | age identity (private key). Only on the machine running the restore drill, never on the server |
| `PLAID_REDIRECT_URI` | for OAuth institutions | absolute http(s) URL | exact OAuth redirect URI registered in the Plaid dashboard, e.g. `http://localhost:3000/plaid/oauth`; no query/fragment, `https://` in production; see [OAuth redirect](#oauth-redirect-us-issuers) |
| `CRON_SECRET` | no | string, >= 32 chars | bearer secret for `npm run sync` (see [Cron](#cron)); the server refuses to start if it is set but shorter |
| `ENABLE_HSTS` | no | `0` \| `1` | default `0`; set `1` only behind HTTPS. Read at runtime by middleware (not baked in at build) |
| `BACKUP_DIR` | no | path | scripts only (`npm run backup`); default `<dir of DB_PATH>/backups` |
| `BACKUP_KEEP` | no | integer | scripts only; newest N `.age` backups kept, default `7` |
| `BASE_URL` | no | URL | scripts only (`npm run sync`); default `http://127.0.0.1:3000`, must be loopback unless `--allow-remote` |

Validation runs at server startup (`lib/env.ts`). Missing or invalid values throw a clear error before anything tries to talk to Plaid or the DB.

### Encryption key

Aggregator access tokens are stored encrypted (AES-256-GCM, `lib/crypto.ts`) under one 32-byte data key.

- **Generate:** `npm run key:generate` prints a `TOKEN_ENCRYPTION_KEY=...` line (the reminder goes to stderr, so `>> .env.local` appends only the key; if you append, delete the empty `TOKEN_ENCRYPTION_KEY=` line copied from `.env.example` so there is no duplicate).
- **Store:** in a password manager, and in `.env.local` (mode `0600`) or a `0600` file referenced by `TOKEN_ENCRYPTION_KEY_FILE`. Never in `data/`, never in backups, never in git. The key must not live in the same copy as the database, or a copied `data/` folder is a token leak.
- **Without it:** the server refuses to start (`lib/boot.ts` → `loadDataKey()`); there is no plaintext fallback. A key that is not exactly 32 bytes is also refused. `next build` does not need the key.
- **If you lose it:** the stored tokens cannot be decrypted. Delete the affected items and re-link every card. Ciphertext is prefixed with a key version (`v1.`) so a later rotation can decrypt with the old key and re-encrypt with the new one.
- **At rest:** tokens live in `plaid_items.access_token_ct` only (migration `0004 token_ct` moved them there, dropped the plaintext column, ran `VACUUM` and wrote a `token_migration` row to `security_log`). A row that no longer decrypts raises `TokenUnreadableError` and is logged as `token_decrypt_failed` with the item id only; the card must be re-linked. The DB directory is forced to `0700` and the DB/WAL/SHM files to `0600` on every open.
- **After upgrading an existing install:** old backups under `data/backups/*.sqlite` still contain plaintext tokens. Destroy them (`npm run backup -- --purge-plaintext`) and run `npm run verify:no-plaintext`, which exits 1 if any file under `data/` still contains a Plaid token prefix.

### Host disk encryption

Full-disk encryption on the host is required. If the host is a VPS and SQLCipher is not used, a snapshot of the running disk exposes transaction and liability text. Token ciphertext stays safe in that case only because the data key is not in the same copy; keep `TOKEN_ENCRYPTION_KEY` out of `data/`, out of backups and out of any cloud-synced folder.

## Security headers

`next.config.mjs` applies the headers from `docs/SECURITY.md` 3.10 to every response (built in `lib/security-headers.mjs`): `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a locked-down `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (issuer OAuth popups), and `Cross-Origin-Resource-Policy: same-origin`. `Cache-Control: no-store` is set on `/api/*` and HTML routes. `Cross-Origin-Embedder-Policy` is never set because it breaks Plaid Link.

**Content-Security-Policy and the script nonce.** `middleware.ts` generates a fresh 128-bit nonce per request and sets `Content-Security-Policy` (from `buildCsp` in `lib/security-headers.mjs`) on every page response, including `/login`, `/plaid/oauth` and the redirect to `/login`. `script-src` is `'self' 'nonce-<nonce>' https://cdn.plaid.com`; the policy is also forwarded as a request header (plus `x-nonce`) so Next.js stamps the nonce on its own inline scripts. That only works for pages rendered per request, so `app/layout.tsx` calls `await connection()` to make every page dynamic. `/api/*` serves JSON and keeps a static, nonce-less CSP from `next.config.mjs`. `connect-src`, `frame-src` and the rest are limited to this origin, Plaid Link (`cdn.plaid.com`) and the Plaid API host for the configured `PLAID_ENV`. `style-src` keeps `'unsafe-inline'` (Tailwind/Radix/sonner emit inline style attributes).

`'strict-dynamic'` is deliberately not used. `react-plaid-link` adds `link-initialize.js` with `document.createElement('script')`, which `'strict-dynamic'` would trust, but `'strict-dynamic'` also makes browsers ignore the `cdn.plaid.com` allowlist, Plaid's script is third-party code we cannot audit for further injection, and Link cannot be exercised in a real browser in CI. The nonce plus host allowlist is enough. Revisit only after a browser-verified Link run.

`upgrade-insecure-requests` is part of the policy only when `APP_ORIGIN` is `https://` (on a plain-http LAN/Tailscale origin browsers would otherwise rewrite every asset URL to https and nothing would load).

`Strict-Transport-Security` is set by `middleware.ts` **at runtime** on every response when `ENABLE_HSTS=1`, so a flag set only on the deploy host works (it is not evaluated at build time). Enable it only when the app is served over HTTPS; browsers cache it for a year. The one remaining build-time input is `next.config.mjs` `headers()`: the static, nonce-less CSP on `/api/*` takes its `connect-src` Plaid host from the `PLAID_ENV` of the build. API responses are JSON, so this has no effect; the page CSP is computed per request from the runtime `PLAID_ENV`.

In `next dev` the policy also allows `'unsafe-eval'` and localhost websockets for HMR (development only).

## Storage modes

You can pick the storage backend per deploy:

- **`sqlite`** (default) — `better-sqlite3` against a local file. Fast, zero ops, perfect for localhost / homelab / a small VPS. Native module, so it does **not** run on Vercel serverless.
- **`libsql`** — Turso / libsql remote. Vercel-compatible. Driver slot exists in `lib/db.ts`; add `@libsql/client` and implement `lib/db/libsql.ts` against the same `DB` interface that `lib/db/sqlite/` implements (not built).
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

**Passkeys need a hostname.** WebAuthn refuses an IP-address relying-party ID, so with `APP_ORIGIN=http://127.0.0.1:3000` or a bare LAN/Tailscale IP only TOTP and recovery codes work. Use `localhost`, a MagicDNS name or the proxy's host name.

**Sessions and cookies**

- 256-bit random token in a cookie named `__Host-amexlens_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`). The database stores only its SHA-256.
- Absolute lifetime 12 h, idle timeout 2 h. The token is rotated on sign-in, on linking a card and on disconnecting one.
- **Sign out** deletes the server row, so any other copy of the cookie dies. **Sign out everywhere** deletes every row.
- Sign-in locks for 15 minutes after 5 failures (global counter, not per IP: `X-Forwarded-For` is spoofable and there is one user). The counter is in memory and resets on restart.
- Every state-changing request must come from `APP_ORIGIN` (`Origin`/`Referer` check) and carry the `X-AmexLens-Request: 1` header (`lib/client/api.ts` adds it). Otherwise `403 { error: { code: "csrf" } }`.
- `middleware.ts` only redirects browsers without a token-shaped cookie to `/login` (API calls get `401` JSON). The real check is `requireSession` / `requireMutation` as the first statement of every handler, so a middleware bypass changes nothing.

**`AUTH_MODE=none`** disables all of this. It exists for local sandbox work and the test suite; the server refuses to start with it in a production build (`NODE_ENV=production`) or with live Plaid credentials (`PLAID_ENV=production`). With `PLAID_ENV=production` it also refuses `COOKIE_INSECURE_DEV=1` and an `http://` `APP_ORIGIN` (`docs/SECURITY.md` 3.1); a production build with sandbox keys may still run over plain http on a LAN/Tailscale host.

`/api/health` is always reachable so external monitors don't need credentials. It answers `{ "ok": true }` (or `{ "ok": false }` with HTTP 503) and nothing else. Operator detail (storage, Plaid env, auth mode, country codes, counts) lives in `GET /api/system`, which requires a session.

## Plaid sync flow

1. `POST /api/plaid/link-token` → server creates a Link token (see [Link token modes](#link-token-modes) for update mode) (`products: [transactions]`, `required_if_supported_products: [liabilities]`, credit-card account filter, per-install random `client_user_id`, country codes from env). Nothing beyond Transactions and Liabilities is ever requested; boot fails if that list widens.
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

### Link token modes

`POST /api/plaid/link-token` takes `{ "mode"?: "new" | "consent" | "repair", "item_id"?: string }` (default `new`) and answers `{ link_token, expiration, mode }` only. It needs a session plus the `X-AmexLens-Request` header like every mutation, and is limited to 10/hour.

| mode | Plaid request | finish step in the browser |
|---|---|---|
| `new` | `products: [transactions]`, `required_if_supported_products: [liabilities]`, `account_filters: { credit: { account_subtypes: ["credit card"] } }` | `POST /api/plaid/exchange { public_token }` |
| `consent` | `access_token` (loaded server-side from `item_id`) + `additional_consented_products: [liabilities]`, **no** `products` array | `POST /api/plaid/consent { item_id }` |
| `repair` | `access_token` alone (the fix for `ITEM_LOGIN_REQUIRED`) | `POST /api/plaid/repair { item_id }` |

All modes send `user.client_user_id` (the per-install random id), `client_name`, `language` and `country_codes`, plus `redirect_uri` only when `PLAID_REDIRECT_URI` is set. `webhook` is never sent. An unknown `item_id` is `404 item_not_found`. The access token never leaves the server.

### Granting liabilities access to an existing card

A card linked before Liabilities was requested (or at an institution that asked for consent later) shows **Consent required** on `/settings`, and its row gets a **Grant liabilities access** button. It opens Link in update mode for that card (`consent` mode above). When Link finishes the browser calls `POST /api/plaid/consent { item_id }`, which re-reads liabilities once from the free cached endpoints (never the billed balance call), moves the card from `consent_required` to `active` if Plaid now answers, and returns `{ ok, liabilities_status, item_status }`. Limited to 6/hour per card. Re-linking cannot create data an institution does not provide: a `not_supported` result stays `not_supported`.

A card whose login expired shows **Needs re-link** and a **Reconnect** button (`repair` mode). Its finish step, `POST /api/plaid/repair { item_id }`, clears the flag and runs one sync; the response is `{ ok, sync: { ok, error_code? } }` and a sync that still fails flags the card again. The access token does not change in either update flow, so nothing is exchanged and no Item slot is used.

### OAuth redirect (US issuers)

Many US institutions (American Express US, most US banks) authenticate with OAuth: Link sends the browser to the bank and the bank sends it back to a URL you registered. Whether a given Canadian institution does this is not assumed; see [Canadian institutions](docs/data-providers.md#canadian-institutions).

1. Register the exact URL in the Plaid dashboard (Developers > API > Allowed redirect URIs), e.g. `http://localhost:3000/plaid/oauth` for sandbox. Production must be `https://`. Plaid compares the string exactly: no query, no fragment, same scheme/host/port/path.
2. Put the same string in `.env.local` as `PLAID_REDIRECT_URI`. It is validated at startup (absolute http(s) URL, no query or fragment; `https://` required when `PLAID_ENV=production`) and sent as `redirect_uri` on every Link token. Leave it empty and OAuth institutions will fail to link, other institutions are unaffected.
3. Right before it opens Link, the app stores `{ token, mode, item_id, created_at }` in `sessionStorage["amexlens_plaid_link"]`; the record is cleared on success or exit. After the bank redirect, `/plaid/oauth` reads it (a record missing or older than 30 minutes shows "Link session expired. Start again from Settings."), re-opens Link with the same token and `receivedRedirectUri`, runs the same finish step as the button, and returns to `/settings`. The link token is never put in a URL.

`/plaid/oauth` is exempt from the sign-in redirect (the bank's redirect is a cross-site navigation) but it performs no action by itself: every API call it makes needs a session and the CSRF header.

### Sandbox verifier

`npm run verify:sandbox` checks, against Plaid's sandbox only, which of the 11 card fields a credit account really returns. It refuses to run unless `PLAID_ENV=sandbox`, reads `PLAID_CLIENT_ID`/`PLAID_SECRET` (sandbox keys) from `.env.local`, uses the `plaid` SDK directly, and never touches the app database or `TOKEN_ENCRYPTION_KEY`.

```bash
npm run verify:sandbox                      # sandbox Item (ins_109508, user_good/pass_good) -> /accounts/get + /liabilities/get
npm run verify:sandbox -- --with-liabilities   # create the Item with liabilities consent (see below)
npm run verify:sandbox -- --balance         # also /accounts/balance/get (billed in production, free in sandbox)
npm run verify:sandbox -- --coverage ins_100533,ins_39,ins_42
```

For each credit account it prints the mask, the currency and, per field key, `present` or `null`. It never prints a value, an Item id or a token. On a failure it prints the Plaid `error_code` (for example `ADDITIONAL_CONSENT_REQUIRED` when the Item was created without Liabilities; use `--with-liabilities`). The sandbox Item is removed with `/item/remove` in a `finally`. Exit code 1 on any failure. `--coverage` downloads Plaid's [institution coverage CSV](https://plaid.com/documents/us_institution_coverage.csv) to a temp file and prints the `liabilities`, `balance` and `transactions` flags (1 = listed) for the ids you give.


## Cards API, refresh and field statuses

`GET /api/cards` returns the cards overview, derived at read time from stored provider data (nothing in it is client-writable):

```jsonc
{
  "cards": [{ "id", "institution_name", "name", "mask", "iso_currency_code", "item_id", "item_status", "last_synced_at",
              "liabilities_status", "balance_source", "last_refreshed_at",
              "fields": { "<field>": { "status", "value", "observed_at", "error_code", "provider" } },
              "utilization": { "ratio", "computed": true, "reason?" },
              "urgency", "days_until_due" }],
  "totals_by_currency": { "CAD": { "balance", "statement_due", "utilization": { "ratio", "included", "excluded" } } },
  "counts": { "overdue", "due_soon" },
  "today": "YYYY-MM-DD",          // America/Toronto
  "generated_at": "..."
}
```

Cards are sorted overdue, due soon (today..+7 days), scheduled by date, past-but-not-overdue, unknown. Totals are per currency and are never summed across currencies; utilization is `sum(balance) / sum(limit)` over cards that have both, and `excluded` counts the rest.

**Fields** are `current_balance`, `available_credit`, `credit_limit`, `statement_balance`, `minimum_payment`, `next_payment_due_date`, `last_payment_amount`, `last_payment_date`, `last_statement_issue_date`, `is_overdue`, `apr`. Each one carries a status; a missing field is shown as missing, with the reason, and there is no manual entry or override:

| status | meaning |
|---|---|
| `present` | value came from the provider (`is_overdue: false` is a real value) |
| `not_supplied` | the call worked and the field was null / an empty APR list |
| `not_supported` | the institution or product does not offer it (`PRODUCTS_NOT_SUPPORTED`, `NO_LIABILITY_ACCOUNTS`) |
| `consent_required` | Plaid needs additional consent for Liabilities (`ADDITIONAL_CONSENT_REQUIRED`); the item is marked `consent_required` |
| `error` | the call failed or is not ready yet (`PRODUCT_NOT_READY`); `error_code` is a provider code, never a message |

**Refresh semantics.** Every transaction sync (manual, cron, first link) also refreshes the cards of that item using the free cached `/accounts/get` plus `/liabilities/get`; a failure there never fails the sync or rolls back transactions. `POST /api/cards/{id}/refresh` is the only path that calls the billed `/accounts/balance/get`; it is limited to one call per card per 10 minutes (429 with `Retry-After`), falls back to the cached balance when the live call fails, and the response says which one you got (`refresh.balance_source`: `realtime` or `cached`). The sync response also carries `cards: { overdue, due_soon }` counts, which `npm run sync` prints (no amounts).

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
| `needs_relink` | Plaid reports the login is no longer valid (`ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN`) | click **Reconnect** on `/settings`; a later successful sync returns it to `active` |
| `consent_required` | Plaid needs additional consent (`ADDITIONAL_CONSENT_REQUIRED`) | click **Grant liabilities access** on `/settings` (update-mode Link) |
| `revoke_failed` | Disconnect could not be confirmed by Plaid; the local row and token are kept | click **Retry revoke** on `/settings` |

Disconnect revokes at Plaid first and deletes locally only after Plaid accepts (or says the item is already gone).

## Cards overview

`/` is the cards overview (`/spending` is the previous spending dashboard; `/transactions` and `/settings` are unchanged in purpose). It reads `GET /api/cards` and shows, top to bottom:

- **Urgency banner**: counts only ("2 cards overdue · 1 due within 7 days"), red if any card is overdue, amber if any is due within 7 days, otherwise "Nothing due in the next 7 days". It also shows today's America/Toronto date and when the response was generated.
- **Totals, one group per currency** (total balance, due this cycle = sum of statement balances, overall utilization). CAD and USD are never added together and there is no combined figure. Utilization is `sum(balance) / sum(limit)` over cards that have both, and its caption says how many cards were used and how many were excluded.
- **One tile per card**, already sorted by the API: institution, name, last four digits, currency, an urgency chip, then current balance, statement balance, minimum payment, next due date (with "in N days"), available credit, credit limit, utilization (labelled "computed": the app derives it, no issuer supplies it), last payment (amount and date), every APR the issuer reported (the penalty APR is labelled "Penalty") and the overdue flag. The footer shows `last_synced_at`, `last_refreshed_at` and whether the balance is "cached" or "live", in Toronto time.

**Urgency rules** (America/Toronto civil dates, see `lib/cards/urgency.ts`): *overdue* when the issuer flags it, or the due date has passed and the issuer did not say "not overdue" (red); *due soon* from today through today + 7 days (amber, "Due today" / "Due in N days"); *scheduled* later than that (neutral); *past due date, issuer reports not overdue* (grey, common with stale sandbox dates); *due date unavailable* (grey).

**Gap text.** A field Plaid did not give us is shown as missing, with the reason, never as zero or blank. The words come from the per-field status stored with each observation, and the tooltip adds the provider and `observed_at`:

| status | text shown |
|---|---|
| `not_supplied` | Not supplied by Plaid |
| `not_supported` | Plaid does not support this field at this institution |
| `consent_required` | Reconnect Plaid to grant liabilities access |
| `error` | Unavailable (Plaid error `<error_code>`) |

A card whose Plaid connection needs attention also shows a badge pointing at Settings: *Reconnect needed*, *Grant liabilities access* or *Disconnect incomplete*.

**Refresh balance (billed Plaid call)** on a tile calls `POST /api/cards/{id}/refresh`, the only path that asks Plaid for a live balance. It is billed per call by Plaid and limited to one per card per 10 minutes. Syncs and cron use the free cached balance.

**Nothing on this screen is editable, by design.** There is no input, override or manual entry for any card field: values come from the aggregation API or are shown as missing.

## Delete all local data

Settings has a *Privacy and data* panel (what is pulled, that Plaid Inc. processes it in the United States, what is stored locally, and that tokens are encrypted at rest while the host disk must be encrypted) and a *Danger zone*. Typing `DELETE` enables **Delete all local data**, which calls `DELETE /api/data` (session + CSRF headers required, like every mutation):

1. Every item is revoked at Plaid first, one after another, with the same revoke-then-delete path as disconnecting a single card.
2. If any revoke fails the response is `502 { error: { code: "revoke_incomplete" }, results: [{ item_id, ok, code? }] }` and nothing else is deleted. Items that did revoke are already gone, as with a normal disconnect; the failed ones stay (`revoke_failed`) so you can fix the cause and run it again.
3. If all revokes succeed (or there were no items), one transaction deletes `transactions`, `account_fields`, `accounts`, `plaid_items` and every `settings` key except `plaid_client_user_id` (the WebAuthn user handle lives in `auth_state`, which is kept), then the database is `VACUUM`ed and the session cookie is rotated.

The `security_log` table is **kept** and gets a `data_delete_all` row (counts only). Plaid retains data under its own policy; this app does not claim Plaid deleted its copy. Sign-in factors (TOTP, passkeys, recovery codes) are not touched, and backups already written under `data/backups/` are not deleted.

## Currencies

Spending totals and the monthly trend are computed **per currency** (grouped by the transaction's `iso_currency_code`); CAD and USD amounts are never added together and there is no combined figure. The dashboard shows a currency selector when more than one currency exists (default CAD, then the first; remembered in `localStorage` as `amexlens.currency`). Transactions with no currency code are grouped as `UNKNOWN`, shown as a plain number with a "currency unknown" caption. Month keys and the "this month" range use the America/Toronto date; each transaction is bucketed by its own civil `date`.

- `GET /api/stats/totals?from&to[&item_id][&include_non_spending][&currency]` returns `{ from, to, currencies, byCurrency: { CAD: { byBucket, grandTotal } } }`.
- `GET /api/stats/trend?months[&item_id][&include_non_spending][&currency]` returns `{ months, currencies, byCurrency: { CAD: MonthlyTrendPoint[] } }`.
- `GET /api/stats/currencies` returns `{ currencies }`. `currency` must match `^[A-Z]{3}$` or be `UNKNOWN`, else 400.

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
  page.tsx                         cards overview (home): urgency banner, per-currency totals, card tiles
  spending/page.tsx                spending dashboard (KPIs, buckets, trend)
  transactions/page.tsx            filterable table + override
  settings/page.tsx                items, sync, system status, privacy panel, delete-all-local-data
  login/page.tsx                   first-run setup (TOTP, recovery codes, passkey) and sign-in
  plaid/oauth/page.tsx             Plaid OAuth return page (resumes Link; exempt from the login redirect)
  api/
    plaid/{link-token,exchange,sync,consent,repair}/route.ts
    data/route.ts                  DELETE: revoke every item, then wipe local card data
    cards/route.ts                 GET overview; cards/[id]/refresh/route.ts POST live balance
    items/[id]/route.ts            disconnect a card
    items/route.ts                 list cards
    transactions/{[id],}/route.ts  list / patch / reset bucket
    stats/{totals,trend,currencies}/route.ts  per-currency aggregations
    auth/status                    which factors exist (public, no secrets)
    auth/setup/{totp/start,totp/confirm,passkey/options,passkey/verify,recovery}
    auth/login/{totp,passkey/options,passkey/verify,recovery}
    auth/logout, auth/sessions     delete this session / every session
    health/route.ts                always-public { ok } probe
    system/route.ts                operator detail (storage, env, counts); session required
components/                        SWR-driven client UI (AuthSettings.tsx = factors, sign out)
                                   overview: CardTile, FieldValue (gap text), CurrencyTotals, UrgencyBanner;
                                   settings: PrivacyPanel, DangerZone
lib/
  auth/                            session.ts (requireSession, rotate), guard.ts (requireMutation, CSRF),
                                   totp.ts, passkey.ts, recovery.ts, lockout.ts, cookie.ts, from.ts
  types.ts                         BucketKey, Transaction, etc.
  categorize.ts                    Plaid -> bucket rules
  env.ts                           validated env loader
  db.ts                            DB interface (ItemsRepo + TransactionsRepo + StatsRepo + CoreRepo) + driver dispatch
  db/sqlite/index.ts               opens the DB, runs migrations, composes the repos
  db/sqlite/{items,transactions,stats,core,cards,auth,maintenance}.ts   per-area better-sqlite3 repos
  db/migrations/                   NNNN_name.sql files plus code steps in index.ts
  audit.ts                         security_log writer
  log.ts                           JSON-line logger + redact() (tokens, secrets, cookies, Plaid error bodies)
  errors.ts                        TokenUnreadableError (token ciphertext cannot be opened -> re-link)
  crypto.ts                        AES-256-GCM data key core
  boot.ts                          startup config checks (called from instrumentation.ts)
  client/api.ts                    browser fetch wrapper (apiFetch, ApiError)
  plaid.ts                         PlaidApi factory, least-privilege Link scopes (assertLeastPrivilege)
  plaid-user.ts                    per-install random client_user_id
  providers/{types,plaid,plaid-fields,index}.ts   CardProvider, Plaid adapter, explicit field pickers, registry
  cards/{merge,urgency,refresh,view}.ts           merge on read, Toronto-date urgency, refresh after sync, API view
  security-headers.mjs             header set + CSP builder (nonce, upgrade-insecure-requests)
  transactions.ts                  /transactions/sync loop (per-item lock, cursor CAS, SyncError)
  sync/{lock,authorize}.ts         per-item mutex; /api/plaid/sync authz (CRON_SECRET bearer OR session + CSRF)
  items/revoke.ts                  revoke-then-delete
  http/{body,errors,params,rate-limit}.ts       64 KiB body cap, safe error bodies, query parsing, in-process rate limits
  date.ts, format.ts, id.ts        small helpers
middleware.ts                      nonce CSP, HSTS (runtime), cookie-shape gate (redirect / 401); handlers do the real check
scripts/sync.mjs                   cron-friendly sync trigger (CRON_SECRET bearer)
scripts/key-generate.mjs           prints a fresh TOKEN_ENCRYPTION_KEY line
scripts/verify-sandbox.mjs         sandbox-only field-presence check + coverage CSV lookup
scripts/backup.mjs                 consistent snapshot -> age-encrypted data/backups/*.sqlite.age
scripts/restore-check.mjs          decrypts a backup to a temp file and opens it read-only (restore drill)
scripts/verify-no-plaintext.mjs    scans data/ for plaintext Plaid token prefixes
scripts/log.mjs                    JSON-line logger for the scripts (mirror of lib/log.ts)
test/                              vitest suites, helpers (loadApp, plaid-fake) and fixtures; test/e2e = attacker suite
docs/                              SECURITY.md (bar + checklist), RED-TEAM.md, ARCHITECTURE.md, data-providers.md
instrumentation.ts                 runs assertBootConfig() when the server starts
```

## Scripts

| command | what it does |
|---|---|
| `npm run dev` | Next dev server on `127.0.0.1:3000` (`-H 127.0.0.1`) |
| `npm run build` / `npm start` | production build + start (`start` also binds `127.0.0.1`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint flat config (`eslint.config.mjs`, `eslint-config-next`) |
| `npm test` / `npm run test:watch` | vitest unit and integration suites (node env, temp SQLite file per test; see `test/helpers/`) |
| `npm run test:e2e` | attacker suite (`test/e2e`, `vitest.e2e.config.ts`): builds once, starts `next start` on `127.0.0.1:3131` with a temp DB, attacks it over HTTP and in Chromium (needs `npx playwright install chromium`); `E2E_SKIP_BUILD=1` reuses `.next`. See `docs/RED-TEAM.md` |
| `npm run sync` | hits `/api/plaid/sync` on the running server with `Authorization: Bearer $CRON_SECRET` (see [Cron](#cron)); loads `.env.local` via `--env-file-if-exists`. A browser session (with the CSRF header) also works; there is no password login |
| `npm run backup` | consistent snapshot of the DB, age-encrypted to `BACKUP_AGE_RECIPIENT`, written to `data/backups/amexlens-<timestamp>.sqlite.age` (mode `0600`, newest 7 kept); `-- --purge-plaintext` also deletes legacy `*.sqlite` backups; refuses to run without a recipient; loads `.env.local` |
| `npm run restore:check -- <file.age>` | restore drill: decrypts with `AGE_IDENTITY_FILE` to a temp file, opens read-only, prints migration ids + item count, deletes the temp |
| `npm run verify:no-plaintext [-- <dir>]` | exits 1 (listing file names) if any file under `data/` contains `access-sandbox-`/`access-development-`/`access-production-` |
| `npm run verify:sandbox [-- --balance --with-liabilities --coverage ins_...]` | sandbox-only field-presence check against Plaid (see [Sandbox verifier](#sandbox-verifier)); refuses unless `PLAID_ENV=sandbox`; loads `.env.local` |
| `npm run key:generate` | prints a fresh `TOKEN_ENCRYPTION_KEY=<base64 32 bytes>` line (see [Encryption key](#encryption-key)) |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, `npm test`, `npm audit --audit-level=high` and build on every PR, plus an `e2e` job that runs `npm run test:e2e`. `.github/workflows/security-scans.yml` (Semgrep, Trivy, gitleaks) is non-blocking. Run `npm test` and `npm run test:e2e` before pushing.

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
3. Expect a line like `migrations=1,2,3,4,5,6 items=<n> integrity=ok`. The script decrypts to a `0600` temp file, opens it read-only, prints only those markers, and deletes the temp file.
4. To actually restore: stop the app first (WAL), decrypt with `age -d -i amexlens-backup.key -o data/amexlens.sqlite <file>.age`, remove any stale `data/amexlens.sqlite-wal` / `-shm`, `chmod 600` the file, start the app. Never overwrite a live DB.

**After the token migration (existing installs):** backups taken before WP3 are plaintext and contain access tokens. Run `npm run backup -- --purge-plaintext` to delete `data/backups/*.sqlite`, destroy any copies elsewhere, then `npm run verify:no-plaintext` to confirm no Plaid token prefix remains under `data/`.

## Verification

A full local smoke test:

1. `cp .env.example .env.local`, fill sandbox creds, `APP_ORIGIN=http://localhost:3000`, a 32+ char `AUTH_SETUP_TOKEN`, and the `TOKEN_ENCRYPTION_KEY` line from `npm run key:generate`. Open `/login` and complete the setup flow (or set `AUTH_MODE=none` for a throwaway sandbox).
2. `npm ci && npm run dev`.
3. `/settings` → Connect → sandbox login (`user_good` / `pass_good`).
4. `sqlite3 data/amexlens.sqlite '.tables'` shows `_migrations`, `plaid_items`, `transactions`, `accounts`, `account_fields`, `sessions`, `security_log` and the auth tables. `SELECT COUNT(*) FROM transactions;` is non-zero.
5. `/` shows a tile per credit card (values or labelled gaps); `/spending` shows the donut + 6-month trend; `/transactions` populates.
6. Override a row's bucket → refresh → override sticks. Click **Sync all** on `/settings` → override still sticks (validates the `bucket_override` guard).
7. Click **reset** on the overridden row → it returns to the categorizer's choice.
8. Link a second sandbox item → the **All cards** filter chip appears in the nav; selecting one scopes the dashboard.
9. `curl http://localhost:3000/api/stats/totals?from=2026-04-01&to=2026-04-30` returns `{ from, to, currencies, byCurrency: { CAD: { byBucket, grandTotal }, ... } }`.
10. `curl -i http://127.0.0.1:3000/api/items` → `401` JSON; `curl -i http://127.0.0.1:3000/transactions` → `307` to `/login?from=%2Ftransactions`; `curl -H 'Cookie: amexlens_auth=ok' http://127.0.0.1:3000/api/items` → `401`; `/api/health` still answers.

## Deployment

The checklist below is the deployment half of `docs/SECURITY.md` 3.9. The repository enforces the loopback bind, the file modes, the boot refusals and the headers; everything else here is host configuration you must do and that the code cannot check.

- **Run a production build bound to loopback.** `NODE_ENV=production`, `npm run build && npm start` (`next start -H 127.0.0.1`). Never `next dev` on a reachable interface. A reverse proxy (Caddy or nginx) on the same host terminates TLS and forwards to `127.0.0.1:3000`; redirect HTTP to HTTPS there. Behind the proxy, `APP_ORIGIN` is the public `https://` origin and the app's login redirect is built on it.
- **TLS and HSTS.** Terminate TLS at the proxy and turn HSTS on once TLS works, either at the proxy or with `ENABLE_HSTS=1` (read at runtime). With `PLAID_ENV=production` the server refuses an `http://` `APP_ORIGIN` or redirect URI and `COOKIE_INSECURE_DEV=1`.
- **Tailscale or a private bind is the recommended exposure.** Pull-only sync needs no public endpoint. If the host is internet-reachable, add a per-IP throttle at the proxy for `/api/auth/login/*` (the app's lockout is a single global counter by design, so five bad codes from anywhere lock sign-in for 15 minutes) and drop requests that carry `x-middleware-subrequest` (the handlers do not rely on it). A Tailscale/LAN IP origin cannot use passkeys; use a MagicDNS or proxy host name.
- **Dedicated unprivileged OS user**, a `0600` env file (or systemd `LoadCredential`) for `.env.local` and the key file, and systemd hardening: `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ReadWritePaths=` limited to the `data/` directory and logs, `UMask=0077`. Keep the install directory not writable by the app user except `data/` and logs. Keep NTP running.
- **Full-disk encryption (LUKS, FileVault) is required.** Transactions and liability values are plaintext in the SQLite file; only tokens and the TOTP secret are column-encrypted. A hypervisor snapshot of a running VPS disk therefore exposes transaction and liability text unless SQLCipher is added (not built).
- **Keep `TOKEN_ENCRYPTION_KEY` out of `data/`, out of backups and out of any cloud-synced folder.** Do not put `data/` in Dropbox, iCloud or Syncthing.
- **Backups off the box.** `npm run backup` from cron (alongside `npm run sync`), then copy the `.age` files off the host. The age identity (private key) never lives on the server. Run the [restore drill](#backups-and-restore-drill) once with the real identity.
- **Separate environments.** Different Plaid secrets, env files and DB files for sandbox and production; the code cannot tell which keys it holds.
- **After deploy**, from another host: the raw Node port is unreachable, `GET /api/transactions` without a cookie returns `401` JSON, and `curl -I` shows the headers in [Security headers](#security-headers).

## Known limitations

- Nothing here has run against a real Plaid environment: all Plaid behavior is tested with fixtures. Plaid Link under the CSP and an issuer OAuth popup under `Cross-Origin-Opener-Policy: same-origin-allow-popups` still need one manual sandbox run (`docs/RED-TEAM.md` section 6).
- Sync is pull-only (cron or the Sync buttons). No webhook is implemented, and there are no reminders (ntfy/email); the urgency banner and the `npm run sync` summary line are the only notifications.
- Only Plaid is wired in. A card whose institution has Liabilities off (for example Desjardins, PC Financial, Simplii, Vancity Visa) shows its due date, minimum, statement balance, last payment, APR and overdue flag as "not supported"; a Yodlee adapter is a possible future fill, justified only if a card you hold needs it.
- A refresh replaces every stored observation for the item: if `/liabilities/get` fails transiently, previously present liability values show as an error (with the reason and time) until the next successful sync. Balances and limits are kept when only the liabilities call fails.
- Transactions, card names/masks and liability values are stored unencrypted in SQLite (tokens and the TOTP secret are encrypted). Full-disk encryption is mandatory (see Deployment).
- Single owner only: one TOTP secret, one WebAuthn user handle, one set of recovery codes. No account recovery beyond those codes (lose them all and you reset the `auth_state`/`passkeys`/`recovery_codes` tables by hand and run setup again). A passkey cannot be removed from the UI yet (recovery codes and "sign out everywhere" exist), and an item whose token can no longer be decrypted cannot be forgotten locally without SQL.
- The sign-in lockout and the rate limits live in process memory and reset on restart. The lockout counter is global, so it is also a remote lockout lever; throttle per IP at the proxy.
- `security_log` has no retention (about one row per sync or refresh).
- The Plaid client has no request timeout yet: a hung connection holds that item's sync lock until the socket dies.
- Passkeys need a hostname origin, not an IP address.
- A pending → posted transition (Plaid emits `removed(pending_id)` + `added(posted_id)`) drops any manual override on the pending row. v2 could rehydrate by hashing `(date, amount, merchant_name)`.
- libsql + postgres drivers are stubbed; the interface is ready, the driver files are not.
- No multi-currency rollup with FX: stats and card totals are per currency and never combined (see Currencies).
- The full list of residual risks is `docs/SECURITY.md` section 8.

## License

Personal project, no license file. Treat as all rights reserved unless you add one.
