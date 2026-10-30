# AmexLens security architecture

This document is the security baseline for AmexLens, a self-hosted Next.js + SQLite app for one person in Canada. It covers the code on `main` today (Plaid transactions, manual sync, optional shared password) and the planned one-screen overview of every credit card: balances, limits, minimum payments, due dates, and APRs, filled by an account aggregator (Plaid Liabilities, and only if needed Flinks, MX, Finicity / Mastercard Open Finance, or Yodlee).

The builder's pull request for that redesign is not done until the acceptance checklist in [section 5](#5-security-acceptance-checklist) passes. This file is requirements and a review of the current tree. It does not change application code.

This is architectural guidance, not a legal opinion. PIPEDA and provincial privacy law are called out where they change a design choice. Confirm coverage, webhook algorithms, and residency in the provider's current docs and contract before coding them in. Provider behaviour drifts; the control (verify, minimize, revoke, encrypt) does not.

## 1. System and assets

### 1.1 Current architecture

```
browser ──cookie──► Next.js (App Router, middleware.ts)
                         │
                         ├─ /api/auth/login|logout     shared password → cookie "ok"
                         ├─ /api/plaid/link-token      Plaid Link token (products: transactions)
                         ├─ /api/plaid/exchange        public_token → access_token stored in SQLite
                         ├─ /api/plaid/sync            POST pulls /transactions/sync
                         ├─ /api/items, /transactions, /stats
                         └─ /api/health                unauthenticated
                         │
                    better-sqlite3  data/amexlens.sqlite
                         │
                    Plaid API  (PLAID_CLIENT_ID + PLAID_SECRET)
```

There is no webhook receiver and no scheduled worker inside the process. `scripts/sync.mjs` logs into the HTTP API and calls sync. `scripts/backup.mjs` copies the SQLite file.

Auth modes declared in `lib/env.ts`: `none` (default), `password`, `passkey`. Only `none` and `password` exist. `passkey` is accepted as a config value and then fail-closed (no code path issues a session).

### 1.2 Planned architecture

```
browser (one screen)
    │  session cookie
    ▼
Next.js
    ├─ auth: WebAuthn passkey, or TOTP, with a real server-side session
    ├─ link / exchange / disconnect per provider
    ├─ read model: cards, limits, balances, min pay, due date, APRs, recent activity
    ├─ POST /api/webhooks/<provider>     signature verified, no session
    └─ sync job (in-process timer or cron calling a library function, not the user password)
          │
          ▼
SQLite
    accounts, liability snapshots, transactions
    aggregator credentials encrypted at rest (AES-256-GCM)
          │
          ▼
one aggregator (a second only for a card the first cannot see)
    Plaid Liabilities and/or Flinks, MX, Finicity, Yodlee
```

The planned change adds three trust boundaries the current app does not have: a long-lived **aggregator access token** that can read credit balances and APRs, a **public webhook** that must be authentic before it changes stored balances or cursors, and a **sync job** that runs unattended with those tokens.

### 1.3 Assets

| Asset | Where it lives | Impact if disclosed or modified |
|---|---|---|
| Aggregator access token / Flinks LoginId / MX member id + app secret / Yodlee user session | SQLite `plaid_items.access_token` today; provider tables later | Ongoing read of card activity until revoked at the provider. Not the bank password for OAuth items. It is enough to pull history and liabilities. |
| `PLAID_SECRET` and the equivalent provider app secret | Process env (`.env.local`) | With stored item tokens, full API access. Alone, it can mint Link sessions and spend quota. A Yodlee or Flinks **platform** secret is broader: it authorizes calls for every login that provider holds for this app. |
| Bank username and password | Must stay inside the provider's widget. Never in AmexLens. | Direct account takeover at the issuer. Screen-scraping providers store these on the provider side. That is a provider-selection risk, not a column to add. |
| Transactions (merchant, amount, date, category) | SQLite `transactions` | Spending history. Personal information. Fraud and profiling value. |
| Liability snapshot (balance, limit, minimum, due date, APR, statement balance) | Planned tables | What the owner owes and when. Tampering can cause a missed payment. Disclosure is financial personal information. |
| Full PAN, routing number, bank password | Must not be stored. Drop if a provider sends them. | Payment fraud. |
| Session cookie | Browser | Full use of the app, including link, sync, disconnect, and read of all cards. |
| Data encryption key | File outside the DB and outside backups | Decrypts every stored token. Equivalent to the tokens. |
| SQLite file, `-wal`, `-shm`, and `data/backups/` | Disk | All of the above in plaintext today. |
| Webhook signing material | Provider dashboard + local secret or cached JWT keys | Ability to forge balance updates and cursor movement. |

### 1.4 Trust boundaries

1. Browser ↔ Next.js. The browser is untrusted. It may hold a session cookie. It must never receive an access token, provider secret, or data-encryption key.
2. Next.js ↔ SQLite. The database file is trusted only as storage. It is not a secrecy boundary. Anything written there is recoverable from disk, WAL, backups, and snapshots unless encrypted by the application or by a key the snapshot does not include.
3. Next.js ↔ aggregator. TLS to the provider. The provider is an entrusted processor with its own retention and subprocessors. AmexLens remains the place the owner looks when that processor is breached.
4. Aggregator ↔ issuer. OAuth or a credential the provider holds. AmexLens does not participate.
5. Public internet ↔ webhook route. Unauthenticated at the session layer by necessity. Authenticity is the signature.
6. Cron ↔ sync. Must not be "anyone who can reach the port."
7. `cdn.plaid.com` ↔ browser. Plaid Link's script runs in the app origin's trust for the life of the click. CSP limits the damage window; it does not remove it.

### 1.5 Attacker and assumptions

One owner, one deployment, high-value data, no second user to isolate. In scope:

- Another host on the LAN, or the public internet, if the port or the webhook is reachable.
- Another Unix user, a stolen disk, a VPS snapshot, a copied `data/` directory, a synced folder (Dropbox, iCloud, Syncthing).
- A stolen `.env.local` together with a DB backup.
- Forged webhooks, stolen session cookies, brute-forced passwords, middleware bypass.
- A compromised npm dependency or the Plaid Link CDN script.
- An aggregator breach or a provider that retains or resells data. Mitigate by choice of provider, minimum scopes, and revocation. Do not pretend app-layer controls erase it.

Out of scope for the controls below: malware already running as the app user on an unlocked desktop (it can read the process and the key file). Full-disk encryption and a locked session still matter when the machine is off or the file is copied to another account. A reverse proxy in front of a process bound to `127.0.0.1` is the network boundary.

## 2. STRIDE threat model

Severity in the review ([section 4](#4-security-review-of-the-current-code)) uses Critical / High / Medium / Low. In the tables below, "exposed" means the deployment is reachable beyond loopback, which is the intended homelab / VPS / Tailscale case. `AUTH_MODE=none` on a machine that only listens on loopback is still unsafe the moment a tunnel, a reverse proxy, or a second local user appears. Production start must refuse `none`.

### 2.1 Current code

| ID | Element | STRIDE | Scenario | What the code does today | Required end state |
|---|---|---|---|---|---|
| C-S1 | Session | Spoofing | Any caller who can reach the port acts as the owner. | `AUTH_MODE` defaults to `none` (`middleware.ts:6-7`, `lib/env.ts:43-47`). Password mode accepts the cookie value `ok` (`middleware.ts:20-21`). | Production refuses `none`. Session is a random token checked against a server-side store. |
| C-S2 | Login | Spoofing | Password guessing. | Plaintext `!==` compare, no rate limit (`app/api/auth/login/route.ts:17`). | Argon2id or, preferably, passkey / TOTP. Rate limit. Constant-time compare where a compare remains. |
| C-S3 | Cookie | Spoofing | Cookie theft on the network, or fixation. The value is not secret. | Cookie is `httpOnly` and `SameSite=Lax`, not `Secure`, value is the literal `ok`, 30-day `maxAge` (`login/route.ts:21-26`). Logout clears the browser cookie and leaves every other copy valid (`logout/route.ts:6-8`), because there is no server session to delete. | `__Host-` cookie, `Secure`, `HttpOnly`, `SameSite=Lax` (Lax so issuer OAuth can return), short absolute lifetime, idle timeout, server-side revocation. |
| C-T1 | SQLite | Tampering | Anyone who can write the file changes balances, categories, or swaps in their own access token. | File mode is whatever the umask produced (`lib/db/sqlite.ts:88-92`). No checksum on rows. | Mode `0600`, directory `0700`, app OS user, encrypted tokens. The UI treats the DB as authoritative only along the sync path. |
| C-T2 | Sync cursor | Tampering | Two overlapping syncs save cursors out of order. A newer cursor can be overwritten by an older one, so Plaid replays or the app skips a window. | No mutex (`lib/transactions.ts:30-61`, `app/api/plaid/sync/route.ts`). Cursor is written only after a full `has_more` loop, which is the right crash behaviour and the wrong concurrency behaviour. | One sync per item at a time. Compare-and-set on the cursor. |
| C-T3 | Exchange body | Tampering | Client-supplied institution name is stored as fact. | `app/api/plaid/exchange/route.ts:19-20`. | Persist institution id and name from Plaid's item response, not from the browser. |
| C-R1 | Audit | Repudiation | After a disconnect, a sync, or a login failure, nothing durable records who did it or whether Plaid revoke succeeded. | No audit table. `itemRemove` errors are swallowed (`app/api/items/[id]/route.ts:18-23`). | Append-only security log: login success/failure, link, revoke result, sync start/end, webhook accept/reject. No tokens in that log. |
| C-I1 | Access token | Information disclosure | Disk, backup, or another local user reads every Plaid item token in the clear. | `plaid_items.access_token TEXT NOT NULL` (`lib/db/migrations/0001_init.sql:3`). `scripts/backup.mjs:14-17` copies the live file, plaintext, beside the DB. WAL/SHM are not copied and still hold recent pages. | AES-256-GCM on token columns. Encrypted backups. Key not in the backup. `0600`. VACUUM after any plaintext migration so free pages do not keep the old token. |
| C-I2 | API errors | Information disclosure | Plaid's error document is returned to the browser and thrown into UI errors. | `exchange/route.ts:43-47`, `link-token/route.ts:18-22`, `sync/route.ts:23-27`. Client code surfaces response text (`components/Providers.tsx:8`, `components/PlaidLinkButton.tsx:17`, `components/SyncButton.tsx:18`, `app/settings/page.tsx:34`). | Stable client error id. Server log gets the Plaid `request_id` and `error_code` only. |
| C-I3 | Health | Information disclosure | Unauthenticated probe learns auth mode, Plaid environment, country codes, item count, transaction count. | `app/api/health/route.ts:21-29`, exempted in `middleware.ts:13`. | Public body is `{ "ok": true }` or `{ "ok": false }`. Detail sits behind the session. |
| C-I4 | Items API | Information disclosure | Sync cursor is returned to the client. Access token is not. | `app/api/items/route.ts:10-12` strips `access_token` and spreads the rest, including `cursor`. | Response allowlist: id, institution name, last synced, status. |
| C-I5 | Redirect | Information disclosure / open redirect | `?from=` is taken from the query string and passed to `router.replace`. | `app/login/page.tsx:9` and `:26`. Middleware itself only writes a path (`middleware.ts:24-25`). | Allow only a single-slash relative path (`^/[$A-Za-z0-9/_\-]*$`). Reject scheme, backslash, and `//`. |
| C-D1 | Sync and Link | Denial of service | Unauthenticated `POST /api/plaid/sync` and `POST /api/plaid/link-token` burn Plaid rate limits and hold the SQLite writer. The sync loop buffers every page in memory (`lib/transactions.ts:35-49`). | No rate limit, no auth when `AUTH_MODE=none`. | Auth plus per-route limits. Page to the DB incrementally. |
| C-D2 | Login | Denial of service | Tight loop against `/api/auth/login`. | No limit. | 5 failures / 15 minutes, then 429. |
| C-E1 | Middleware | Elevation of privilege | All authorization is one string compare in middleware. A Next.js middleware bypass skips every route. | Handlers do not check a session. `next` is `^14.0.0` with no lockfile (`package.json:17`). CVE-2025-29927 (`x-middleware-subrequest`) bypassed middleware auth on 14.x before 14.2.25. | Pin a patched Next.js. Block that header at the proxy. Check the session inside every handler except the webhook verifier and the minimal health probe. |
| C-E2 | Revoke | Elevation of privilege | Disconnect reports success when Plaid still holds a live item. The local token is then deleted, so the owner cannot retry revoke without a backup. | `app/api/items/[id]/route.ts:18-23`. | Revoke first. On failure, keep the row, mark `revoke_failed`, show the error code, retry. Only delete locally after the provider accepts removal or the operator confirms the item is already dead. |
| C-E3 | Cron | Elevation of privilege | `BASE_URL` receives the owner's password. A wrong or hostile base URL is password theft. The cron credential is the interactive password. | `scripts/sync.mjs:5-22`. | In-process sync. If an HTTP cron remains, a separate high-entropy `CRON_SECRET` header, constant-time compare, bound to loopback. |

### 2.2 Planned architecture

These are the additional threats the redesign introduces. Current threats in section 2.1 stay in force.

| ID | Element | STRIDE | Scenario | Required control |
|---|---|---|---|---|
| P-S1 | Webhook | Spoofing | Attacker posts a fake liabilities or transactions webhook and moves the cursor, deletes transactions, or overwrites balances and due dates. The owner pays the wrong amount or pays late. | Verify the provider signature over the **raw** body before any state change. Reject on failure with 401. See [section 3.4](#34-webhook-signature-verification). |
| P-S2 | Webhook replay | Spoofing | A captured valid webhook is replayed to force a resync or a removal. | Check timestamp skew (Plaid: `iat` within 5 minutes). Store the provider event id and reject duplicates. Processing is idempotent. |
| P-S3 | Sync job | Spoofing | Anything that can hit the sync URL triggers a pull with the stored token. | Job runs in-process under the app user, or presents `CRON_SECRET`. It is not the user session and not `AUTH_MODE=none`. |
| P-S4 | Link session | Spoofing | Attacker starts Link with the owner's Plaid keys and attaches the attacker's own item, or completes a flow the owner did not start. | Link-token route requires a session. Optional: short-lived server-side `link_session` row matched at exchange. |
| P-T1 | Liability fields | Tampering | A bug writes client-supplied balance, APR, or due date into the snapshot the overview trusts. | Those columns are written only by the sync path from the provider response. No PATCH for them. |
| P-T2 | Allowlist | Tampering | A provider payload with extra fields (`numbers`, owners, full account number) is persisted because the code spreads the JSON into SQL. | Explicit column allowlist per provider. Unknown fields are dropped, not stored and not logged. |
| P-R1 | Disconnect | Repudiation | Owner thinks a card was removed at the bank and at the provider. Local delete succeeded and the remote revoke did not. | Audit row with provider status code. UI states "removed here, still authorized at the provider" until revoke succeeds. |
| P-I1 | Liabilities | Information disclosure | Balances, APRs, minimums, and statement dates join the SQLite file and every backup. | Same encryption and backup rules as tokens for the secret columns. Transaction and liability **contents** are personal information: full-disk encryption, file mode `0600`, and encrypted backups are mandatory even when only tokens are column-encrypted. |
| P-I2 | Over-collection | Information disclosure | Enabling Auth, Identity, or statement-PDF download to "fill in" a missing APR pulls routing numbers or a document that contains a PAN. | Product and account filters in [section 3.5](#35-least-privilege-provider-scopes). Missing APR stays unknown on screen. |
| P-I3 | Logs and webhooks | Information disclosure | The webhook body or the liabilities JSON is logged "for debugging" and ends up in journald, a log shipper, or an error page. | Redaction list in [section 3.6](#36-logging). Log provider event id and outcome, not the body. |
| P-I4 | Processor | Information disclosure | The aggregator stores the same data, often in the United States, under its own retention and secondary-use terms. A local encrypt does not cover that copy. | Provider choice in [section 6](#6-aggregation-provider-trade-offs). Disconnect must call the provider's delete/revoke. Record what the provider still keeps. |
| P-I5 | Cross-user constant | Information disclosure | `client_user_id` is the fixed string `amexlens-local-user` (`app/api/plaid/link-token/route.ts:11`). Harmless for one install. It becomes a correlation id if two people ever share a Plaid client. | One random id generated at first boot and stored locally. Not an email, not a name. |
| P-D1 | Webhook flood | Denial of service | Public route accepts large bodies, holds the SQLite write lock, or calls the provider on every unsigned post. | Body size cap (64 KiB is enough for a notification; fetch details server-side). Rate limit. Verify signature before DB work and before any provider call. |
| P-D2 | Provider outage | Denial of service | Sync holds a transaction open across HTTP calls. | HTTP outside the SQLite write transaction. Timeout on provider calls. |
| P-E1 | Scope creep | Elevation | "While we have the item, also pull identity and auth." | Dashboard products and the code's product list are exactly Liabilities + Transactions (or the provider's card-only equivalent). CI or a startup assert fails if Auth/Identity appear. |
| P-E2 | Middleware exemption | Elevation | Webhooks are exempted the way `/api/health` is, and the handler forgets to verify. | Every middleware exemption is listed in this file and has its own authenticator. Checklist item. |
| P-E3 | Second provider | Elevation | Four aggregators mean four long-lived secrets and four revoke bugs. | Ship one provider. Add another only behind the same token-encryption, webhook, and revoke interface, for a card the first provider cannot see. |

### 2.3 Data flow for a card (planned)

```
Owner unlocks session (passkey or TOTP)
        │
        ▼
POST /api/plaid/link-token          products: liabilities + transactions
        │                           account_filters: credit card, country CA
        ▼
Plaid Link in the browser           bank credentials stay in the widget / issuer OAuth
        │ public_token (short-lived)
        ▼
POST /api/plaid/exchange            server exchanges, encrypts access_token, inserts item
        │
        ▼
sync job                            liabilitiesGet + accountsGet (balance, limit) + transactionsSync
        │ allowlist fields
        ▼
SQLite                              overview reads snapshots only
        │
        ▼
webhook (signed)                    "something changed" → enqueue the same sync. Webhook does not carry the balance the UI trusts unless it was verified and allowlisted.

Disconnect
        │
        ▼
provider revoke  →  on success, delete rows  →  VACUUM  →  audit
```

The browser never sees `access_token`. The webhook never writes a balance that did not pass signature verification and the column allowlist.

## 3. Required controls

### 3.1 Secrets management

| Secret | Handling |
|---|---|
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, and any other provider app secret | `0600` env file owned by the app user, or systemd `LoadCredential`. Not in the repo, not in the image, not in `NEXT_PUBLIC_*`, not in shell history. Different secrets for sandbox and production. Production boot refuses `PLAID_ENV=sandbox`. |
| Aggregator item token / LoginId | Encrypted column. Decrypted in memory for the duration of one provider call. Never sent to the browser, never put in a query string, never logged. |
| `AMEXLENS_DATA_KEY` | 32 random bytes in a file outside `data/` and outside backup sets. Mode `0600`. Not derived from the login password (password change and offline guessing would become key compromise). |
| Session token | 256 bits from `crypto.randomBytes`. Store only SHA-256 in `sessions`. Cookie holds the raw token. |
| `CRON_SECRET` | 256 bits, distinct from the data key and the user credential. Compare with `crypto.timingSafeEqual`. |
| Webhook secrets | Provider-specific. Plaid uses published ES256 keys fetched and cached, not a shared password. Shared secrets for other providers follow the data-key file rules. |
| `.env.local` | Already gitignored (`.gitignore` ignores `.env*` and keeps `.env.example`). Keep it that way. `data/` stays gitignored. |

Startup checks, fail closed:

- Production and `AUTH_MODE=none` → refuse to boot.
- `AUTH_MODE=passkey` while passkey routes are unimplemented → refuse to boot. The current tree accepts the value and then cannot issue a session (`lib/env.ts:43-55`, `app/api/auth/login/route.ts:8-9`). That is fail-closed for access and false assurance for the operator.
- Data key missing or shorter than 32 bytes → refuse to boot. Do not fall back to plaintext tokens.
- `PLAID_SECRET` present and `PLAID_ENV=production` while the public base URL is `http://` → refuse to boot.

Rotation: provider secret rotated in the provider dashboard, then the env file, then process restart. Item tokens are rotated by the provider's update-mode / re-consent flow, not by inventing a new token locally. Data-key rotation: decrypt with previous key, re-encrypt with current key, delete the previous key file only after a successful pass. Ciphertext is prefixed with a key version (`v1.`).

### 3.2 Encryption at rest and key management

Threats to cover, in order: another local user, a copied `data/` folder, an unencrypted backup, a disk image. Full-disk encryption (LUKS, FileVault) is required and is not sufficient. A snapshot of a running VPS, or a backup script that copies the file off the disk, sees plaintext pages. Column encryption of tokens still holds in that case **if the key is not in the same copy**.

**Token column (mandatory)**

- Algorithm: AES-256-GCM. 12-byte nonce from `crypto.randomBytes` per write. 16-byte tag. No CBC, no ECB, no unauthenticated AES.
- Additional authenticated data: the item id (and provider name). Swapping ciphertext between rows must fail authentication.
- Storage: `access_token_ct` blob, version byte or `v1.` prefix. Drop the plaintext column in the migration.
- On decrypt failure: the sync for that item fails, the overview shows "needs re-link", and the error log records "decrypt failed" without the ciphertext.
- After the one-time migration from plaintext: `VACUUM`, delete old backups, delete `-wal` and `-shm` only when the process is stopped, and confirm with a string search that the known token prefix is gone from `data/`.

**Financial rows (mandatory at the deployment layer, recommended at the column layer)**

Merchant names, amounts, balances, APRs, and due dates are personal financial information. Required deployment controls:

- Full-disk encryption on the host.
- SQLite file, `-wal`, `-shm`, and the containing directory mode `0700`/`0600`. Set this in `createSqliteDB` after open, and again on backup output. Do not trust umask.
- Backups encrypted to an age (or equivalent) public key. The private key is offline, not next to `data/backups/`.

SQLCipher (or another whole-file encryption better-sqlite3 is actually built against) is the right additional control when the host can be snapshotted while unlocked (typical VPS). It is a native build change. If SQLCipher is not in the PR, the acceptance checklist still requires FDE, `0600`, encrypted backups, and column encryption of tokens, and the PR description says that a hypervisor snapshot of the running disk exposes transaction text.

Do not encrypt the token with a key stored in the same SQLite file.

### 3.3 Auth hardening

Target for any deployment that stores an aggregator token: **passkey (WebAuthn) as the primary factor, TOTP as an acceptable alternative, recovery codes for device loss.** A shared long-lived password is a weaker option and is only tolerable on a Tailscale-only bind with the extra password controls below. `AUTH_MODE=none` does not ship in production.

**Passkey**

- `@simplewebauthn/server` (the README already reserves this). Relying party ID is the exact host. User verification required. No resident-credential requirement that would block the owner's hardware key.
- Challenge stored server-side, single use, 5-minute TTL.
- No email magic link. There is no identity provider.
- Recovery codes: 10, shown once, stored as hashes, each single use.

**TOTP (if passkey is not what lands in this PR)**

- Secret encrypted with the data key, or stored as a hash of the enrollment only after verification of the first code.
- 30-second step, window ±1, replay cache of the last accepted step.
- Rate limit as for passwords.

**Password, only if a PR still has it**

- Argon2id hash (memory-hard parameters documented in the PR). Never store `AUTH_PASSWORD` for comparison in plaintext.
- `crypto.timingSafeEqual` on the derived hashes, or the library's verify function.
- Minimum 14 characters. Refuse the example and dictionary values.
- Same rate limit.

**Session**

- Cookie name `__Host-amexlens_session` (implies `Secure`, `Path=/`, no `Domain`).
- `HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/`.
- Use Lax rather than Strict so a top-level return from issuer OAuth still sends the cookie. Lax does not send the cookie on cross-site POST. That is not the whole CSRF story; section 3.3 CSRF still applies.
- Absolute lifetime 12 hours. Idle timeout 2 hours. Rotate the token on login and on link / disconnect.
- Logout deletes the session row. A copied cookie dies with the row.
- Middleware may redirect browsers to `/login`. Handlers still return **401 JSON** for `/api/*` when the session is missing or unknown. A redirect of an API call is not an auth check (`middleware.ts:23-26` currently redirects everything, including API routes).

**CSRF**

SameSite=Lax blocks the classic cross-site form POST. Keep it, and add both of:

- For every state-changing route, `Origin` (or `Referer` if Origin is absent) must match the configured app origin. Missing both → 403.
- A custom header such as `X-AmexLens-Request: 1` on those routes. Browsers will not attach it to a simple cross-site form.

Webhook routes do not use the session and do not use this header. They use signature verification.

**Rate limits** (in-process is correct while there is one Node process and one SQLite file):

| Route | Limit |
|---|---|
| Login / WebAuthn assertion / TOTP | 5 failures per 15 minutes, then 429 |
| Link token | 10 per hour |
| Exchange | 10 per hour |
| Manual sync | 6 per hour per item, plus the cron |
| Webhook | 60 per minute; signature failures 10 per minute then 429 |

**Login redirect**

`from` must match `^/[A-Za-z0-9/_\-]*$` and must not start with `//`. Otherwise send the owner to `/`.

### 3.4 Webhook signature verification

Prefer pull-only sync on a private bind if a public listener is not worth it. A webhook is a new internet-facing route. If it exists, these rules are mandatory.

Shared rules for every provider:

1. Exempt the path from session auth in middleware only together with a comment that points at the verifier.
2. Read the **raw** body (`req.text()`), cap the size, then parse JSON. Signature input is the raw bytes, not a re-serialized object.
3. Verify before writing SQLite and before calling back to the provider with a secret.
4. Reject with 401 on bad signature, bad algorithm, stale timestamp, or unknown key id. Return 200 only after the event is authenticated and durably queued or applied.
5. Idempotency key = provider event id. Duplicates are 200 and a no-op.
6. The webhook updates a "needs sync" flag or enqueues work. It does not accept a client-style JSON patch of balances.
7. Do not log the body. Log provider, event id, item id, and accept/reject.
8. IP allowlists are optional and insufficient. Plaid does not promise stable source IPs.

**Plaid** (implement this, do not approximate it):

- Header: `Plaid-Verification`, a JWT.
- Algorithm must be ES256. Reject `none` and anything else.
- `kid` selects a key from `/webhook_verification_key/get`. Cache keys. On unknown `kid`, refresh once, then reject.
- Verify the JWT signature with that JWK.
- Claim `request_body_sha256` must equal the hex SHA-256 of the raw body, compared in constant time.
- `iat` within five minutes of now.
- Official reference: Plaid's webhook verification docs. Re-read them when implementing; do not copy a blog.

**Flinks, MX, Finicity, Yodlee:**

Use the mechanism in that provider's current documentation (HMAC over the raw body, or a shared secret header you configured, or callback verification). Confirm the header name and the algorithm at implementation time and name both in the PR. A webhook handler that only checks a static path, a shared guessable query string, or "the JSON looks right" fails the checklist. If the provider cannot authenticate webhooks, do not expose a webhook; poll.

### 3.5 Least-privilege provider scopes

AmexLens is a credit-card overview. Collection stops at what that screen shows.

**Never request, and never persist if a payload includes them:**

- Account and routing numbers (Plaid Auth, Finicity ACH, Yodlee full account number, Flinks account-number attributes).
- Identity / account-holder name, address, phone, email, KYC.
- Investments, income verification, employment, assets for lending.
- Payment initiation, transfers, or anything that can move money.
- Statement PDF downloads. Those files regularly contain a PAN and a mailing address. A missing due date on the API is not a reason to pull PDFs.
- Bank passwords or MFA codes. Linking always goes through the provider widget or issuer OAuth. There is no AmexLens form for issuer credentials.

**Plaid Link token shape the builder should implement:**

```ts
await plaid.linkTokenCreate({
  user: { client_user_id: stableLocalId }, // random id from first boot, not a name
  client_name: "AmexLens",
  products: [Products.Liabilities, Products.Transactions],
  country_codes: [CountryCode.Ca],
  language: "en",
  account_filters: {
    credit: { account_subtypes: [AccountSubtype.CreditCard] },
  },
  webhook: process.env.PLAID_WEBHOOK_URL, // only if webhooks are on
});
```

Today the code requests only `Products.Transactions` (`lib/plaid.ts:36`) and defaults countries to `US,CA` (`lib/env.ts:60-64`, `.env.example:4`). Transactions-only is the right instinct. The country default is wider than this owner. Liabilities is the planned addition and is the maximum product set.

Calls that are in scope: `liabilitiesGet`, `accountsGet` / accounts balance (for current balance and limit), `transactionsSync`, `itemRemove`, `itemGet`, webhook verification key fetch.

Calls that are out of scope: `authGet`, `identityGet`, `identityMatch`, `investments*`, `transfer*`, `income*`, `assetReport*`, processor tokens.

Persist an allowlist from the liabilities and accounts responses: account id, mask, official name, subtype, ISO currency, balance current/available/limit, APR array (type and percentage), minimum payment, next payment due date, last statement balance and dates, overdue flag, last synced time. Drop everything else, including any `numbers` object.

**Other providers, same rule:** request the card-account and liabilities (or attributes) product that returns balance, limit, minimum, due date, and APR. Turn off "all accounts", identity, and bank-number packages in that provider's connect widget. If a Canadian issuer does not return APR or minimum payment, show "unavailable". Do not widen scope to chase it.

`client_user_id` / provider end-user id is a random local identifier, not the owner's name.

### 3.6 Logging

Log security events. Do not log personal financial data or secrets.

Events at info: login success and failure (no password, no TOTP code), link started, exchange succeeded (item id only), sync finished (counts only), revoke result, webhook accept/reject (event id), decrypt failure, rate-limit trip.

Never log, and strip if a dependency logs them:

- `access_token`, `public_token`, `link_token`, processor tokens, LoginId, cobrand password, user session token
- `PLAID_SECRET`, authorization headers, cookies, `CRON_SECRET`, data key
- request or response bodies from Plaid, webhooks, or `/api/transactions`
- merchant name, amount, balance, APR, account number, mask (mask is low sensitivity but useless in logs)

`scripts/sync.mjs:23-28` prints the sync JSON. Counts are acceptable. Error objects from the API are not, until the API stops echoing provider bodies.

A single `redact()` used by the logger, keyed on property name and on known token prefixes, is the expected implementation. Tests feed it a fake access token and assert the output does not contain it.

`/api/health` and error responses must not include secrets. Plaid `error_code` and `request_id` are safe to log on the server. They are not required in the browser toast.

### 3.7 Dependency and supply-chain hygiene

Current gap: `package.json` uses caret ranges for every dependency, including `next`, `plaid`, and `better-sqlite3`, and the repo has **no lockfile**. `npm install` is not reproducible. `next.config.mjs:7` sets `eslint.ignoreDuringBuilds: true`, so lint never gates a production build.

Required:

- Commit `package-lock.json`. Install with `npm ci` in any deploy or CI.
- Pin `next` to a release that includes the CVE-2025-29927 fix (14.2.25 or a later patched 14.2.x, or a current supported release) and re-check [Next.js security advisories](https://github.com/vercel/next.js/security/advisories) when bumping. The proxy workaround is to drop requests that carry `x-middleware-subrequest`.
- Enable Dependabot or Renovate for npm.
- `npm audit --audit-level=high` fails the builder PR's CI, or the PR explains each accepted advisory.
- Native module `better-sqlite3`: upgrade deliberately. A supply-chain compromise there runs as the app user and can read the data key if the key is on disk while the process runs. Keep the app user unprivileged.
- `react-plaid-link` loads `https://cdn.plaid.com/link/v2/stable/link-initialize.js` into the page. That script is inside the app's origin trust when Link is open. Pin it with CSP `script-src` (below). Subresource integrity will not survive Plaid's stable channel; do not vendor a stale copy either. Residual risk: a compromise of `cdn.plaid.com` can act as the logged-in owner during linking. Accepted only with CSP restricting that host, session rotation after link, and no other third-party script.
- Do not add a second CDN script for another provider without the same CSP change in the same PR.
- Secrets do not enter the client bundle. Keep provider modules on `import "server-only"`. No `NEXT_PUBLIC_PLAID_SECRET` or equivalent.

### 3.8 Backup encryption

`scripts/backup.mjs` is a plaintext `copyFileSync` of a live WAL database. That misses a consistent snapshot and writes tokens to `data/backups/` in the clear. Replace it with all of:

1. Consistent snapshot (`better-sqlite3` backup API, or `VACUUM INTO`, with the app's normal locking). The snapshot still contains secrets.
2. Encrypt the snapshot to an age public key. Delete the plaintext temp file in a `finally`. Output mode `0600`.
3. The age private key is not stored on the server, or is stored outside any path the backup job reads.
4. Retention: a small local set (for example 7 snapshots). Old plaintext backups are destroyed as part of the token-encryption migration.
5. Restore drill documented in the PR: decrypt, open read-only, confirm a known non-secret marker. Do not restore a snapshot over a live file without stopping the process (WAL).
6. Do not put `data/` in a cloud sync folder. Sync tools upload the DB and the key if both are in the folder.

### 3.9 Secure deployment defaults

- `NODE_ENV=production`. `next start` bound to `127.0.0.1`. A reverse proxy (Caddy or nginx) terminates TLS. No `next dev` on a reachable interface. The dev server is an extra attack surface and the default auth mode is `none`.
- Firewall: inbound only to the proxy, or no inbound and Tailscale only. Webhook, if enabled, is the only public path, and it is the verified route.
- Dedicated OS user. systemd (or equivalent): `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ReadWritePaths=` limited to the DB directory and the log directory. `UMask=0077`.
- App directory not writable by the app user, except `data/` and logs. A compromised Node process should not be able to rewrite `middleware.ts` and survive a restart from a read-only install. (If the deploy is a writable checkout, say so in the PR as accepted residual risk.)
- HSTS on the proxy once TLS works. Redirect HTTP → HTTPS.
- Sandbox and production are different Plaid keys and different DB files.
- Time sync (NTP). Webhook `iat` checks depend on it.
- After deploy, an external request to the raw Node port fails, and an external request to `/api/transactions` without a cookie returns 401.

### 3.10 Headers and CSP

Set these on every response in `next.config.mjs` `headers()`, not only on HTML. API responses carry financial JSON and need the cache and frame protections too.

| Header | Value |
|---|---|
| `Content-Security-Policy` | See below. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` on HTTPS only. |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` (issuer OAuth opens a popup; `same-origin` alone breaks that flow. Confirm with one OAuth bank during verification.) |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `no-store` on HTML and all `/api/*` |

Do not set `Cross-Origin-Embedder-Policy: require-corp`. It breaks Plaid Link.

CSP for the Plaid-only app (tighten hosts if the builder uses a single environment):

```
default-src 'self';
script-src 'self' https://cdn.plaid.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self' https://production.plaid.com https://sandbox.plaid.com;
frame-src https://cdn.plaid.com;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
upgrade-insecure-requests
```

`'unsafe-inline'` on styles is there because the current UI stack (Tailwind, Radix, sonner) emits inline style attributes. Do not add `'unsafe-inline'` or `'unsafe-eval'` to `script-src`.

`logo_url` is stored (`lib/transactions.ts:24`) and is not rendered today. Before any `<img src={logo_url}>`, allowlist the image host (Plaid merchant logos) in `img-src`. A raw provider URL in `src` is a tracking pixel and an open redirector for the browser. Do not server-side fetch `logo_url` (SSRF).

If a second aggregator widget needs another script origin, add that origin in the same PR that adds the widget, and nowhere else.

### 3.11 Privacy operational controls (PIPEDA)

PIPEDA's commercial-activity scope often excludes a natural person handling only their own household records. The aggregators are commercial processors and are in scope. Design as if the owner is accountable for the transfer: their breach, secondary use, and retention become this app's incident. The moment the app is hosted for anyone else, or run by a company, PIPEDA applies directly to the operator. Quebec's Law 25 is stricter (confidentiality incidents, cross-border assessment, consent) for organizations in Quebec; a household deployment is not an enterprise privacy program, and a US processor is still a residency decision the owner should make with eyes open. Federal reform (Bill C-27 / CPPA) had not replaced PIPEDA; re-check before calling anything "CPPA compliant."

Map the principles onto the product:

| Principle | What the PR does |
|---|---|
| Identify the purpose | Settings states, in a short paragraph, that the app pulls credit-card balances, limits, minimums, due dates, APRs, and transactions, and names the processor and country. |
| Consent | Consent is the provider widget plus the owner's click on "Connect". No background link. Disconnect is available per card. |
| Limit collection | Section 3.5. Canada only. Credit cards only. |
| Limit use and retention | Data is for the overview. No ads, no export to a third party, no training. On disconnect: revoke, delete local rows, VACUUM. Document the provider's residual retention from their policy (do not invent a "deleted everywhere" claim). |
| Accuracy | The overview shows `last_synced_at` per card and does not present a stale balance as live. Sync errors stay visible. |
| Safeguards | Sections 3.1–3.10. |
| Individual access and correction | The only data subject is the owner. They can see every row the app holds. Category override already exists. A "delete this card" and a "delete all local data" action are required with the redesign. |
| Cross-border | If the processor stores data in the United States, say that on the settings page. US legal process can reach a US processor; Canadian residency (Flinks, if the contract confirms a Canadian region) is the mitigation. |

Incident runbook (keep it next to the host, not only in git):

1. Stop the process and the cron. Remove the public webhook if one exists.
2. In the provider dashboard, revoke every item and rotate the app secret. Rotating the secret does not by itself invalidate item access tokens; `itemRemove` (or that provider's equivalent) does.
3. Rotate the data key, session secret, and cron secret. Invalidate all sessions.
4. Decide what left the machine: token-only (OAuth item → remote read of financial data until revoke) versus provider-held bank password (credential-based connection → contact the card issuer). An AmexLens disk leak is the first case for OAuth items. A provider breach may be the second.
5. Restore only from an encrypted backup you trust, onto a clean data key, or re-link from scratch.
6. Write down time, what was exposed, and what was revoked. That note is the record if a provincial breach duty ever applies.

## 4. Security review of the current code

Reviewed tree: application source on `main` (`middleware.ts`, `app/api/**`, `lib/**`, `scripts/**`, `next.config.mjs`, `package.json`, `.env.example`, `.gitignore`). No runtime pentest and no npm install in this review. Line numbers refer to that tree.

### 4.1 Findings

| ID | Sev | Location | Finding | Fix |
|---|---|---|---|---|
| F-01 | Critical | `middleware.ts:6-7`, `lib/env.ts:43-47`, `.env.example:10` | Default auth mode is `none`. Every route then runs with no check: list transactions, mint a Link token on the owner's Plaid keys, exchange a public token, sync, disconnect. Safe only on an unreachable loopback, and the start scripts do not pin the bind address (`package.json` `dev` / `start`). | Refuse `none` when `NODE_ENV=production`. Bind `127.0.0.1`. Default `.env.example` to a mode that actually authenticates, with a comment that `none` is a local sandbox footgun. |
| F-02 | Critical | `middleware.ts:20-21`, `app/api/auth/login/route.ts:21-26`, `app/api/auth/logout/route.ts:6-8` | The session is the static string `ok`. Anyone who can set that cookie is the owner. Logout cannot revoke a second copy. There is no session store. | 256-bit random token, SHA-256 at rest, `__Host-` cookie, server-side delete on logout. Reject the literal `ok`. |
| F-03 | Critical | `lib/db/migrations/0001_init.sql:3`, `lib/db/sqlite.ts:88-97`, `scripts/backup.mjs:14-17` | Plaid access tokens are plaintext in SQLite. Backups are a plaintext copy next to the DB. WAL mode is on (`sqlite.ts:91`), so `copyFileSync` of the main file is also an inconsistent snapshot and leaves `-wal`/`-shm` beside it. | AES-256-GCM column, `0600`, encrypted backups, VACUUM after migration. Section 3.2 and 3.8. |
| F-04 | High | `package.json:17`, absence of a lockfile, all handlers under `app/api/**` | Authorization exists only in middleware. Next.js CVE-2025-29927 bypasses middleware with `x-middleware-subrequest` on 14.x before 14.2.25. The dependency is `^14.0.0` with no lockfile, so a fresh install is not pinned to a patched release. Handlers would not notice the bypass. | Pin a patched Next.js, commit the lockfile, drop the header at the proxy, and check the session inside each handler. |
| F-05 | High | `app/api/auth/login/route.ts:17-26` | Password is stored and compared in plaintext with `!==` (not constant-time). No rate limit, no length rule. Cookie is not `Secure`, lives 30 days, and is not `__Host-` prefixed. | Section 3.3. Prefer removing shared-password auth in favour of passkey or TOTP. |
| F-06 | High | `app/api/items/[id]/route.ts:18-23` | `itemRemove` errors are ignored and the local row is deleted anyway. The Plaid item stays live, and the only copy of the access token the app had is gone, so retry needs a backup that still contains the token. The UI says the card is disconnected (`app/settings/page.tsx:28-36`). | Revoke-then-delete. Surface failure. Audit the provider result. |
| F-07 | High | `app/api/plaid/exchange/route.ts:43-47`, `app/api/plaid/link-token/route.ts:18-22`, `app/api/plaid/sync/route.ts:23-27`, `components/Providers.tsx:8`, `components/PlaidLinkButton.tsx:17`, `components/SyncButton.tsx:18`, `app/settings/page.tsx:34`, `scripts/sync.mjs:23-28` | Provider error bodies go to the client, into toast text, and into the cron log. Today those bodies are mostly Plaid `error_code` / `error_message` / `request_id`. The pattern will leak tokens or liabilities the moment a handler throws a request config or a payload. | Generic client error. Server-side allowlist of `error_code` and `request_id`. |
| F-08 | Medium | `app/api/health/route.ts:8-29`, `middleware.ts:13` | `/api/health` is intentionally unauthenticated and reports `auth_mode`, `plaid_env`, country codes, and how many items and transactions exist. Useful to an attacker scanning the port. | Public response is ok/not ok. Move the rest behind the session. The settings page can keep the detail for a logged-in owner. |
| F-09 | Medium | `next.config.mjs:1-13` | No CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, frame, or permissions headers. `Referrer-Policy` default can leak paths. Clickjacking and a third-party script are unconstrained. | Section 3.10. |
| F-10 | Medium | `app/login/page.tsx:9`, `app/login/page.tsx:26`, `middleware.ts:23-26` | Post-login `from` is an unvalidated query parameter passed to `router.replace`. Middleware also sends unauthenticated **API** calls through an HTML redirect instead of 401, and puts the path in `from`. | Allowlist relative paths. API auth failures return 401 JSON and do not redirect. |
| F-11 | Medium | `scripts/sync.mjs:5-22` | Cron posts `AUTH_PASSWORD` to `BASE_URL`. The job's credential is the interactive password, and the destination is an env var. | In-process sync, or loopback plus a distinct `CRON_SECRET`. |
| F-12 | Medium | `lib/db/sqlite.ts:88-92` | The DB is created with the process umask (often `0644`). On a multi-user host that is world-readable tokens and transactions. No `chmod` after create. | `fs.chmod` of the file to `0600` and the directory to `0700` on open. |
| F-13 | Medium | `lib/transactions.ts:30-61`, `app/api/plaid/sync/route.ts` | No per-item lock. Overlapping syncs can persist an older cursor after a newer one and drop or duplicate a window. Crash safety of "write cursor after the loop" is good and should stay. | In-process mutex per `item_id`, or a `syncing` column compare-and-set. |
| F-14 | Medium | `app/api/plaid/exchange/route.ts:27-47` | The public token is exchanged before the insert. If the insert throws (duplicate `item_id`, disk full), Plaid has issued an access token that this database does not store, so `itemRemove` is awkward to retry. Institution name and id are taken from the client body (`:19-20`). | Persist the token (encrypted) in the same flow before further work. On duplicate, load the row and revoke the duplicate token. Take institution metadata from `itemGet`. |
| F-15 | Low | `lib/env.ts:43-55`, `app/api/auth/login/route.ts:8-9` | `AUTH_MODE=passkey` passes validation and has no implementation. Login returns 400. Middleware still demands a cookie. Operators can believe passkeys are on. | Throw at startup until the WebAuthn routes exist. |
| F-16 | Low | `app/api/plaid/link-token/route.ts:11-14`, `lib/env.ts:60-64` | Link user id is a global constant. Default country codes include `US`. Products are correctly limited to transactions (`lib/plaid.ts:36`). | Random per-install user id. Default `CA`. Keep the product cap; add Liabilities only under section 3.5. |
| F-17 | Low | `app/api/items/route.ts:10-12` | Access tokens are stripped (keep this). The Plaid sync cursor is still returned to the browser. | Allowlist the JSON fields. |
| F-18 | Low | `lib/id.ts:2-6` | Item ids are `Date.now()` plus `Math.random()`. They are not credentials, and they are guessable enough that a future unauthenticated disconnect route would be a problem. With F-01 fixed they are still the wrong primitive. | `crypto.randomUUID()`. |
| F-19 | Low | `lib/db/sqlite.ts:252-266` | Transaction filters are parameterized. `LIMIT`/`OFFSET` are integer-coerced before interpolation, which avoids SQL injection. `%` and `_` in `q` are not escaped, so a search can become a wildcard. | Escape LIKE metacharacters. Keep using bound parameters. |
| F-20 | Low | `next.config.mjs:7` | ESLint does not run during `next build`, so a later security lint rule cannot fail the deploy. | Fail the build on lint, or run lint in CI as a required check. |

### 4.2 Controls that are already right

Keep these during the redesign:

- `GET /api/items` removes `access_token` before JSON serialization (`app/api/items/route.ts:10-12`).
- `lib/env.ts`, `lib/plaid.ts`, `lib/db.ts`, `lib/transactions.ts`, and the SQLite driver are `server-only`. Secrets are not `NEXT_PUBLIC_*`.
- `.gitignore` ignores `.env*` (except `.env.example`) and `data/`.
- SQL predicates are bound parameters. `foreign_keys = ON` and `ON DELETE CASCADE` from items to transactions (`0001_init.sql:15`, `sqlite.ts:92`).
- The transactions cursor is advanced only after a successful `has_more` loop (`lib/transactions.ts:39-59`). Preserve that crash behaviour while adding a lock.
- Manual bucket overrides survive resync when `bucket_override` is set. Integrity of owner edits is a security property of the current sync; keep it when liabilities land.
- Plaid products today are `transactions` only. The browser receives a link token and sends back a public token; the access token stays on the server (`app/api/plaid/exchange/route.ts:27-39`).
- The password cookie is `httpOnly` and `SameSite=Lax`. Those two flags stay; the value, the lifetime, and the missing `Secure` / server session do not.

## 5. Security acceptance checklist

The builder's PR passes only when every box is true or the PR describes a deferred item and the threat it leaves open. Deferred items cannot include F-01, F-02, F-03, F-04, F-06, webhook verification, or scope limits.

### Auth and session

- [ ] Production start refuses `AUTH_MODE=none`.
- [ ] Production start refuses `AUTH_MODE=passkey` unless WebAuthn registration and assertion work end to end.
- [ ] Primary login is a passkey (user verification required) or TOTP. If a password remains: Argon2id, length floor, rate limit, no plaintext compare.
- [ ] Session token is 256 random bits. The database stores a hash. The cookie value `ok` is rejected.
- [ ] Cookie is `__Host-amexlens_session`; `Secure`; `HttpOnly`; `SameSite=Lax`; `Path=/`.
- [ ] Idle and absolute timeouts are enforced. Logout deletes the server row. A second browser's cookie stops working.
- [ ] Every state-changing handler checks `Origin` and a custom header.
- [ ] Unauthenticated `/api/*` returns 401 JSON and does not redirect to HTML.
- [ ] Each handler that reads or writes financial data or tokens checks the session itself, including if middleware is skipped.
- [ ] Login `from` is an allowlisted relative path.
- [ ] Rate limits from section 3.3 are in place on login, link, exchange, and sync.

### Tokens and data at rest

- [ ] Aggregator tokens are AES-256-GCM with random nonce, version prefix, and AAD bound to the item id.
- [ ] Missing data key refuses startup. Plaintext token column is gone. Migration path runs `VACUUM` and calls out destruction of old plaintext backups.
- [ ] DB file mode `0600`, directory `0700`, set in code on open.
- [ ] Backups are consistent and age-encrypted. The private key is outside the backup input. A restore was run once on a fixture.
- [ ] Full-disk encryption is documented as a host requirement. If the host is a VPS and SQLCipher is not used, the PR states that a snapshot of the running disk exposes transaction and liability text.
- [ ] No API response, error body, log line, or client toast contains an access token, public token, secret, cookie, or data key. A unit test plants a fake token in an error path and asserts redaction.

### Aggregator

- [ ] One provider in the PR. A second provider is a separate change with the same interface.
- [ ] Products / widget scopes are liabilities (or card attributes) plus transactions, credit cards only, country CA. Auth, identity, investments, income, statement PDF, and payment initiation are absent from code and from the provider dashboard config described in the PR.
- [ ] The issuer password never hits an AmexLens route. Link uses the provider widget.
- [ ] Persisted fields are an allowlist. A fixture payload that includes an account number or routing number does not land in SQLite.
- [ ] Institution name is taken from the provider, not from the browser.
- [ ] Disconnect calls provider revoke first. Failure keeps the local credential, surfaces the error, and writes an audit row. Success deletes local rows.
- [ ] `client_user_id` (or equivalent) is a random per-install id.
- [ ] Sandbox cannot boot with production keys and the reverse.
- [ ] Overview shows `last_synced_at`. Balances and due dates are not writable from the client.

### Webhooks and sync

- [ ] If no webhook is implemented, there is no public unauthenticated route other than the minimal health probe, and sync is pull-only.
- [ ] If a webhook exists: raw body, size cap, provider signature verified before any DB write or provider call, stale and replayed events rejected, failures are 401, duplicates are idempotent.
- [ ] Plaid verification matches section 3.4 (ES256, `request_body_sha256`, `iat`, key fetch). Other providers name the header and algorithm from current docs in the PR.
- [ ] Sync is serialized per item. Cursor updates stay "after success."
- [ ] Cron does not send the user password. In-process job or `CRON_SECRET` on loopback.
- [ ] Provider HTTP calls sit outside SQLite write transactions.

### Privacy

- [ ] Settings text names the processor, the data elements, and the storage country.
- [ ] Delete-card and delete-all-local-data exist. Delete-card includes remote revoke.
- [ ] The PR does not claim the provider deleted their copy unless the provider's API said so.
- [ ] Incident steps in section 3.11 are still accurate after the code change, or they were updated in this file in the same PR.

### Browser, headers, supply chain, deploy

- [ ] Headers in section 3.10 are present on HTML and `/api/*` (verified with `curl -I`).
- [ ] CSP has no `script-src` `'unsafe-inline'` or `'unsafe-eval'`. Plaid (and only the providers this PR uses) are the only third-party script/frame hosts.
- [ ] `logo_url`, if rendered, is https and host-allowlisted. The server does not fetch it.
- [ ] `package-lock.json` is committed. `next` is a CVE-2025-29927-patched release or later. `npm audit --audit-level=high` is clean or each finding is explained.
- [ ] Process listens on `127.0.0.1` only. TLS and HSTS are on the proxy. `next dev` is not the production path.
- [ ] App runs as an unprivileged user. Secrets file mode `0600`.

### Tests the PR must include

- [ ] 401 without a session on: items, transactions, stats, link-token, exchange, sync, disconnect, and the detailed health fields.
- [ ] Cookie `amexlens_auth=ok` is not a session.
- [ ] Forged webhook (bad signature, stale `iat`, replay) changes zero rows.
- [ ] Two concurrent syncs cannot persist an older cursor over a newer one.
- [ ] Revoke failure does not delete the encrypted token.
- [ ] Redaction test for logs and error JSON.
- [ ] Allowlist test: account-number field in a fixture is absent from the database.

## 6. Aggregation provider trade-offs

For this owner the decision is a privacy and coverage decision, not a feature checklist. Every candidate below can hold a long-lived credential that reads bank data. AmexLens should integrate **one** of them. Add a second only for a card the first cannot see, through the same encrypt / verify / revoke path.

Coverage of Canadian **credit-card liability fields** (APR, minimum payment, due date, statement balance) is uneven at every aggregator and changes by issuer. Amex Canada in particular must be confirmed in that provider's current coverage tool. A missing field stays "unavailable". It is not a reason to enable account-number or statement-download products.

Canada's consumer-driven banking framework is the long-term source of accredited, scope-limited API access. It is not yet something an app can assume for every card. Until an issuer offers that API, aggregators still use OAuth where the bank has it and credential-based access (the provider stores a bank password or a long-lived bank session) where it does not. Prefer OAuth connections when the widget offers them. Credential-based connections mean a provider breach is an issuer-credential incident, not only a read-token incident.

| | Plaid | Flinks | MX | Finicity / Mastercard Open Finance | Yodlee (Envestnet) |
|---|---|---|---|---|---|
| Fit for a single Canadian cardholder | Transactions are proven in this repo. Liabilities must be confirmed per Canadian issuer, including Amex Canada. US company. | Purpose-built for Canadian institutions. Strongest default for residency and FI coverage. Confirm liability fields per issuer; do not assume a Plaid-shaped Liabilities object. | US platform. Canadian card coverage is generally the weak point. Poor default for this owner. | Mastercard network, US processing, Canadian coverage expanding and still a per-issuer check. | Broad legacy coverage, US processing, heaviest token model, weakest story on secondary use. |
| What the owner consents to | Plaid Link. OAuth at banks that support it; credentials entered into Plaid's widget otherwise. | Flinks Connect. Same split between OAuth and credentials stored by Flinks. Nightly refresh means Flinks keeps the connection and re-reads on a schedule. | MX Connect widget. OAuth or credentials held by MX. | Finicity Connect. OAuth or credentials held by Finicity. | FastLink. Historically credential-heavy; OAuth where the FI has it. |
| What AmexLens must store | Long-lived `access_token` plus `item_id`. Public token is one-time. App holds `PLAID_SECRET`. | Long-lived LoginId. App holds the instance API secret. The secret plus LoginId is the read credential. | App API key plus member/user identifiers. | Partner secret and app key, plus a customer id. | Cobrand login (platform secret) **and** a user session token. Cobrand compromise is the whole aggregator account, not one card. |
| Webhook authenticity | Specified and implementable: `Plaid-Verification` JWT, ES256, body hash, 5-minute `iat`. Section 3.4. | Confirm the current signature or shared-secret scheme in Flinks docs in the PR. If it is unclear, poll. | Confirm MX's current shared-secret or callback verification in the PR. If it is unclear, poll. | Confirm the current HMAC header and algorithm (historically HMAC-SHA256 over the raw body) in Mastercard's docs in the PR. | Confirm in current Yodlee docs. The cobrand model makes a sloppy webhook worse. Poll if unclear. |
| Data residency | United States. PIPEDA accountability for the cross-border transfer sits with the commercial processor; the owner should still treat US residency as a conscious choice. CLOUD Act reach is real for a US processor. | Canadian company. Contract region has commonly been Canada. Get the region in writing. Best match for a Canadian household that wants the data to stay in Canada. | United States. | United States (Mastercard). Strong enterprise compliance program; residency is still the US unless a Canadian region is in the contract. | United States. |
| Retention and secondary use | Plaid is a processor for the app's request. They also retain data under their own policy. Use `itemRemove` and Plaid's deletion paths. Read the current retention schedule and do not promise the owner the provider copy is gone because the SQLite row is gone. | Nightly refresh is explicit retention on Flinks' side so the connection stays warm. Disable refresh on disconnect. Confirm deletion of the LoginId and cached accounts. | MX retains aggregated member data under its terms. Configure the shortest retention that still supports the overview. | Mastercard publishes consumer-deletion APIs. Call them on disconnect and record the response. | Review the current contract for secondary use and sale of aggregated data. Yodlee has been the subject of public US reporting and regulatory complaints about secondary use of consumer financial data. For a privacy-sensitive single user that history is a reason to pick them last, and only with written terms that forbid sale or secondary use of this connection. |
| Blast radius of an app-side secret leak | `PLAID_SECRET` mints Link sessions and, together with stolen item tokens, reads those items. Item token alone reads that item until `itemRemove`. | Instance secret plus any LoginId reads that login. Protect the instance secret like `PLAID_SECRET`. | API key plus member id reads that member. | Partner secret is account-wide for this app's Finicity customers (here, one person). | Cobrand secret is the worst of the five: it authenticates the application at Yodlee, not a single card. |
| PIPEDA practical note | Comparable-protection depends on Plaid's safeguards and the contract. Say "processed in the United States" in settings. | Best alignment with limiting cross-border disclosure, **if** the signed region is Canada and subprocessors are listed. | Cross-border by default. Harder to justify if Flinks or a confirmed-Canada option covers the same cards. | Cross-border by default. Deletion API is a plus. Coverage, not the brand, decides whether it is needed. | Cross-border plus secondary-use concern. Use only if no other provider supports a specific card, and document why. |

### Recommendation

1. Keep Plaid for the transactions path that already exists **if** Plaid Liabilities for Canada returns balance, limit, minimum payment, due date, and APR for the owner's actual cards. Verify Amex Canada explicitly. Implement section 3.4 and the product cap in section 3.5 in that PR.
2. If those liability fields are missing for the owner's cards, evaluate **Flinks** next, because residency and Canadian FI coverage are the actual gap. Do not add MX, Finicity, and Yodlee in the same redesign.
3. MX is a weak default here: US residency and thinner Canadian card coverage.
4. Finicity is the fallback if a specific card is in Mastercard Open Finance's Canadian coverage and not in Plaid or Flinks. Budget for a US transfer disclosure and for their deletion API.
5. Yodlee is last. The cobrand credential is a larger secret, and secondary-use terms need a harder look than the others.
6. Whichever provider is chosen, AmexLens stores no bank password, encrypts the long-lived token, verifies webhooks or does not listen, and revokes remotely before deleting locally.

## 7. Builder sequence

Do this in the security-sensitive order. A UI that shows APRs on top of F-01 through F-04 is a nicer window onto the same exposure.

1. Pin Next.js, add the lockfile, and move session checks into handlers (F-04) while replacing the static cookie (F-02) and refusing `AUTH_MODE=none` (F-01).
2. Encrypt existing tokens, chmod the database, and replace the backup script (F-03, F-12) before adding liability columns. New columns inherit the file-mode and backup controls.
3. Fix revoke (F-06) and error redaction (F-07) before adding more provider calls.
4. Add Liabilities with the allowlist and CA-only credit-card Link filters. Serialize sync (F-13).
5. Add a webhook only with the verifier in section 3.4, or keep pull-only.
6. Headers, CSP, health minimization, rate limits, and the checklist tests.

Update this document in the same PR if a control changes. A redesign that contradicts section 3 or 5 without editing this file is not ready to merge.
