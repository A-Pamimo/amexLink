# AmexLens red-team report (WP9, Phase 3)

Branch `wp9-red-team`, stacked on `wp7-overview-rebased` (top of the Phase 0–2 chain). Reviewed by an independent pass that read the code, not the PR descriptions. Date: 2026-10-31.

## 1. Scope and method

**In scope.** Everything a caller who can reach the port can do: every `/api/*` route, the middleware gate, the session and factor code (`lib/auth/**`), CSRF, rate limits and lockout, the Plaid adapter and sync path, token encryption and backups, response headers and CSP, boot refusals, the browser code (`components/**`, `lib/client/**`, `app/**/page.tsx`), the ops scripts, dependencies and CI. Out of scope (no keys in CI): a live Plaid Link session, an issuer OAuth popup, a restore on the real host; those are listed in section 6.

**Method.**

1. Checklist-driven read of `docs/SECURITY.md` sections 2.1, 2.2, 3 and 5 against the code on this branch (section 3 below is the row-by-row result).
2. Targeted probes of the things the brief flagged: token leakage paths (`grep` for `access_token|link_token|public_token|error_message|console\.|JSON.stringify(err|\.text()`), `redact()` coverage, session fixation and rotation, CSRF on `/api/auth/*`, setup-token handling, passkey challenge/counter/RP binding, middleware prefix exemptions, pre-auth rate-limit burn, sync CAS and lock re-entrancy, revoke semantics, encryption AAD and migration WAL handling, backup script temp files, CSP/nonce, boot refusals, client sanitisers, supply chain.
3. Runtime attacks over HTTP against a production build (`next start -H 127.0.0.1`), automated as the `e2e` vitest project (section 2), plus manual `curl` probes with forged `Host` / `X-Forwarded-*` headers.
4. A real Chromium (Playwright 1.63, CDP virtual authenticator) for the passkey flow, the `from` redirect sanitiser and CSP enforcement.

Every Critical/High would have been fixed on this branch with a regression test; none was found. The Medium and Low findings that were small to fix are fixed (one commit each); the rest are documented precisely in section 4 for WP8 to record as deferrals.

## 2. Automated attacker suite (`npm run test:e2e`)

`vitest.e2e.config.ts` + `test/e2e/**`. The global setup builds once (`E2E_SKIP_BUILD=1` reuses `.next`), starts `next start -H 127.0.0.1 -p 3131` with exactly

```
NODE_ENV=production AUTH_MODE=required APP_ORIGIN=http://127.0.0.1:3131
AUTH_SETUP_TOKEN=<random, 32+> CRON_SECRET=<random, 32+> TOKEN_ENCRYPTION_KEY=<generated 32 bytes>
PLAID_CLIENT_ID=x PLAID_SECRET=x PLAID_ENV=sandbox COOKIE_INSECURE_DEV=1 DB_PATH=<tmp>/e2e-3131.sqlite
```

(nothing else from the developer's shell), enrols a TOTP secret through `POST /api/auth/setup/totp/start` + `confirm` with the setup token, and kills the server by PID (process group, SIGTERM then SIGKILL) in teardown. Tests mint sessions through the real login routes (`test/e2e/helpers/client.ts` coordinates TOTP steps and recovery codes across files because the server rejects a replayed step). The lockout tests and the browser tests run their own server processes (ports 3132, 3133, 3134): a lockout lasts 15 minutes and WebAuthn refuses an IP-address RP ID, so the browser server's origin is `http://localhost:3134`.

| File | What is attacked | Count |
|---|---|---|
| `routes-401.e2e.ts` | Every `app/api/**/route.ts` on disk (except `health`, `auth/*`), every exported method, with no cookie, `amexlens_auth=ok`, `amexlens_session=ok`, a random 43-char token, the `__Host-` name over plain http; four `x-middleware-subrequest` values; `POST /api/plaid/sync` with a bogus bearer (skips middleware, dies in the handler); `HEAD`/`OPTIONS`; the server log contains no setup token, cron secret or session cookie. Each 401 is JSON `{error:{code:"unauthenticated"}}`, `cache-control: no-store`, no `set-cookie`. | 96 |
| `headers.e2e.ts` | `/api/health` body is exactly `{"ok":true}`; nonce'd CSP without `'unsafe-inline'`/`'unsafe-eval'`/`'strict-dynamic'` on `/login`, `/`, `/settings`, `/transactions`, `/spending`; nonce changes per request and appears on the inline bootstrap scripts; static nonce-less CSP on `/api/*`; `referrer-policy`, `x-frame-options`, COOP, CORP, `nosniff`, `permissions-policy`, `cache-control: no-store`, no `x-powered-by`, no COEP on HTML, API (401 and 200), 404 pages; `/_next/static/*` cacheable; no HSTS on plain http. | 10 |
| `csrf.e2e.ts` | With a valid session: missing `X-AmexLens-Request` → 403; header + foreign/`null`/look-alike `Origin` → 403; no `Origin` + foreign `Referer` → 403; nothing → 403; same-origin `Referer` or correct `Origin` → passes the gate (400 from validation, no Plaid call); the same matrix on `DELETE /api/items/:id`, `PATCH /api/transactions/:id`, `DELETE /api/data`; logout/login/setup/sessions without the header; a cross-site `x-www-form-urlencoded` POST. | 8 |
| `session.e2e.ts` | Cookie is `amexlens_session=<43 chars>; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax`; a second copy works until `POST /api/auth/logout` (clears and kills the row); TOTP replay → 401; login while presenting a session rotates it; `DELETE /api/auth/sessions` kills every browser; a recovery code works once; `/api/auth/status` hides the recovery count from anonymous callers. | 6 |
| `params-bodies.e2e.ts` | `limit=1e9|-1|abc|10^23`, negative/huge `offset`, `q=%`, `q=_`, `q=\`, SQL-ish `q`/`bucket`, 5000-char params, junk dates → 200 and ≤1000 rows; stats routes never 500; hostile card ids → 404; 1 MiB JSON to `/api/auth/login/totp` → 413 and no lockout hit; 1 MiB to `/api/plaid/exchange` (session) → 413; a 4 MiB chunked body without `Content-Length` is cut off; invalid JSON / arrays / null / wrong content-type → 400/401, process healthy after each. | 7 |
| `cron.e2e.ts` | Wrong/empty/`Basic`/case-variant bearer → 401 even with a valid cookie and CSRF headers; bearer in `token=`, `authorization=`, `access_token=`, `cron_secret=` query → 401; correct bearer → 200 counts only, no cookie; session path still needs CSRF; `GET` is not a route. | 5 |
| `data-privacy.e2e.ts` | `DELETE /api/data`: 401 / 403 / 403 / 200 `{ok:true,results:[]}` with a rotated session (old cookie dead); factors survive; `/settings` HTML contains "processes the data in the United States", "Plaid Inc." and "Delete all local data", and no token shape. | 2 |
| `redirects.e2e.ts` | `GET /transactions` → 307 to `/login?from=%2Ftransactions`; query string never travels into `from`; forged `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` never reach the redirect target; `//evil.example/x`, `/\evil.example`, `/%2F%2Fevil.example`, traversal; 18 look-alike paths (`/loginx`, `/api/authx/...`, `/api/auth%2Fstatus`, `/api/healthx`, `/api/health/../items`, `/api/items/`, `/api/%69tems`, `/API/items`, `/api//items`, `/_next/../api/items`, …) never 200; public pages contain nothing sensitive; API routes are never redirected to HTML. | 7 |
| `lockout.e2e.ts` (own servers) | 5 wrong TOTP codes with rotating `X-Forwarded-For`/`X-Real-IP`/`Forwarded` → 401, 6th → 429 with `Retry-After` ≤ 900; a correct never-used code → 429; recovery, passkey options and verify → 429; health/status unaffected. Setup token: 5 wrong → 401 `invalid_setup_token`, 6th → 429, the right token → 429; non-string/short tokens never match. | 3 |
| `browser.e2e.ts` (own server, Chromium) | Enrol a passkey from Settings through the real UI (CDP virtual authenticator: ctap2, internal, UV), sign out, sign in with it; capture the assertion and replay it from the page → 401; re-add the credential to the authenticator with `signCount: 0` (a clone) → sign-in refused with 401, DB counter unchanged, no cookie; a credential ahead of the server counter signs in and the counter follows. `/login?from=//evil.example` (TOTP) and `?from=javascript:alert(1)` (recovery code) land on `/`, `?from=/transactions` lands there; no `alert`. No CSP violation in the console while `/login`, `/`, `/settings`, `/transactions`, `/spending` hydrate. | 3 |

**150 e2e tests, all passing**, 100–110 s locally after the build. CI runs the suite as the `e2e` job (`.github/workflows/ci.yml`, `npx playwright install --with-deps chromium`).

Counter regression is covered end to end with a cloned authenticator state (not only by replaying a consumed challenge); the unit test in `test/auth/passkey.test.ts` covers the same check at the library level.

## 3. Checklist and threat-model pass

Legend: PASS (evidence) · FINDING RT-nn (see section 4) · N/A · DEFER (not satisfiable in code, for WP8 to record).

### 3.1 SECURITY.md §2.1 current-code threats

| ID | Verdict | Evidence |
|---|---|---|
| C-S1 | PASS | `lib/env.ts` defaults `AUTH_MODE` to `required`; `lib/boot.ts` refuses `none` when `NODE_ENV=production` or `PLAID_ENV=production`; sessions are random tokens checked in `lib/auth/session.ts` `requireSession`. e2e `routes-401`. |
| C-S2 | PASS | No password mode exists. TOTP/passkey/recovery under `checkLockout` (`lib/auth/lockout.ts`, 5/15 min); `constantTimeEqual` for TOTP codes and the setup token. e2e `lockout`. |
| C-S3 | PASS | `lib/auth/cookie.ts`: `__Host-amexlens_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, 12 h `Max-Age`; `COOKIE_INSECURE_DEV=1` drops the prefix only off-production (`lib/boot.ts`). Logout deletes the row (`destroySession`). e2e `session`. |
| C-T1 | PASS | `lib/db/sqlite/index.ts` `hardenFileModes` 0700/0600 on open and after migrate; `process.umask(0o077)` in `lib/boot.ts`. `test/db/file-modes.test.ts`. |
| C-T2 | PASS | `lib/sync/lock.ts` per-item promise chain; `casUpdateCursor` in `lib/db/sqlite/items.ts`; cursor written after the loop (`lib/transactions.ts` `syncLocked`). `test/lib/sync-hardening.test.ts`. |
| C-T3 | PASS | `app/api/plaid/exchange/route.ts` reads only `public_token`; institution from `itemGet` + `institutionsGetById`. `test/http/exchange.test.ts` (`Evil Bank` never stored). |
| C-R1 | PASS after RT-08 | `security_log` rows for login success/failure, setup, logout, revoke result, cards refresh, delete-all, token migration and now `link.exchange`. Sync end is a log line (`sync_finished`), not a row: DEFER (section 5). |
| C-I1 | PASS | `access_token_ct` AES-256-GCM with AAD `plaid_items:<item_id>` (`lib/db/sqlite/items.ts`, `lib/crypto.ts`); migration 0004 drops the column, `VACUUM` + `wal_checkpoint(TRUNCATE)` (`lib/db/sqlite/index.ts`); `test/db/token-migration.test.ts` checks the main file and `-wal` after checkpoint; backups age-encrypted (`scripts/backup.mjs`). |
| C-I2 | PASS | `lib/http/errors.ts` `extractProviderError` allowlists `error_code`/`error_type`/`request_id` by regex; never reads `error_message`/`config`; clients show `ApiError.code` through `SAFE_CODE` (`lib/client/api.ts`). `test/lib/log.test.ts`, `test/http/revoke.test.ts`. |
| C-I3 | PASS | `app/api/health/route.ts` is `{ok}` only; detail in `/api/system` behind `requireSession`. e2e `headers`. |
| C-I4 | PASS | `app/api/items/route.ts` explicit allowlist (no `cursor`, no token). |
| C-I5 | PASS | `lib/auth/from.ts` `safeFrom` (`^/[A-Za-z0-9/_-]*$`, no `//`); used by `app/login/page.tsx` `leave()`. e2e `browser` in Chromium. Middleware redirect target: FINDING RT-09 (fixed). |
| C-D1 | PASS | Link-token, exchange, sync, refresh, consent, repair are session-gated first, then `rateLimited` (`lib/http/rate-limit.ts`); unauthenticated callers cannot touch those buckets. Pages are applied per call (`applyTransactionPage`). Body size: FINDING RT-01 (fixed). |
| C-D2 | PASS | `lib/auth/lockout.ts`. Residual: scope-only counter is also a remote lockout lever, RT-02. |
| C-E1 | PASS | `next@15.5.28` pinned, `package-lock.json` committed; every handler starts with `requireSession`/`requireMutation`/`authorizeSync`/`authorizeSetup` (enumerated in 3.3 below); `test/auth/routes-401.test.ts` calls handlers directly; e2e sends the bypass header. |
| C-E2 | PASS | `lib/items/revoke.ts` revoke-then-delete; failure keeps the row and ciphertext, sets `revoke_failed`, audits. `test/http/revoke.test.ts`. Residual RT-11. |
| C-E3 | PASS | `lib/sync/authorize.ts`: header-only bearer, `constantTimeEqual`, never falls through to the session path; `scripts/sync.mjs` refuses a non-loopback `BASE_URL` and `redirect: "error"`. e2e `cron`. |

### 3.2 SECURITY.md §2.2 planned-architecture threats

| ID | Verdict | Evidence |
|---|---|---|
| P-S1, P-S2, P-D1 (webhook) | N/A | No webhook route exists; `middleware.ts` has no webhook exemption; `/api/health` is the only unauthenticated non-auth route (e2e `routes-401` enumerates the disk). Body cap now applies to every JSON route (RT-01). |
| P-S3 | PASS | Cron is `CRON_SECRET` bearer or a browser session + CSRF; never `AUTH_MODE=none` in production. |
| P-S4 | PASS | `/api/plaid/link-token` requires `requireMutation`; `/plaid/oauth` resumes only from this origin's sessionStorage (`lib/client/plaid-link.ts`); redirect URI must be on `APP_ORIGIN` (RT-07, fixed). |
| P-T1 | PASS | Liability columns are written only by `lib/cards/refresh.ts` from the provider response; no PATCH exists (`app/api/cards/**`). |
| P-T2 | PASS | `lib/providers/plaid-fields.ts` explicit pickers; `test/cards/refresh-allowlist.test.ts` plants `numbers`/`owners`/`account_number` and checks every table. |
| P-R1 | PASS | Revoke audit rows with provider code; UI shows "Revoke failed (CODE)" and "Retry revoke" (`app/settings/page.tsx`). |
| P-I1 | PASS / host requirement | Tokens encrypted; transaction and liability text is not column-encrypted. FDE is stated on the settings page (`components/PrivacyPanel.tsx`) and in SECURITY.md 3.2. |
| P-I2 | PASS | `LINK_PRODUCTS=[transactions]`, `required_if_supported=[liabilities]`, credit cards only; `assertLeastPrivilege` at boot and per mode (`lib/plaid.ts`). `test/lib/plaid-scopes.test.ts`. |
| P-I3 | PASS | `lib/log.ts` `redact()`: sensitive key regex, Plaid token shapes, axios errors reduced, `Error` reduced (drops `cause`), depth cap; `config.headers.Authorization` is caught by the key regex, nested arrays are walked. `test/lib/log.test.ts`. |
| P-I4 | PASS | Privacy panel names Plaid Inc. and the United States; delete paths never claim Plaid deleted its copy. |
| P-I5 | PASS | `lib/plaid-user.ts` random per-install `client_user_id`. |
| P-D2 | PASS | Provider calls sit outside `db.transaction` (`lib/transactions.ts` `runPages`, `lib/cards/refresh.ts`). Plaid SDK has no request timeout configured: DEFER (section 5). |
| P-E1 | PASS | `assertLeastPrivilege` throws on anything beyond Transactions + Liabilities. |
| P-E2 | PASS | Every middleware exemption is listed in the `middleware.ts` doc comment with its authenticator; e2e `redirects` checks the prefixes do not stretch. |
| P-E3 | PASS | One provider (`lib/providers/index.ts`). |

### 3.3 SECURITY.md §5 acceptance checklist

**Auth and session**

| Row | Verdict | Evidence |
|---|---|---|
| Production refuses `AUTH_MODE=none` | PASS | `lib/boot.ts`; `test/auth/boot.test.ts`. |
| Production refuses `passkey` mode unless WebAuthn works | PASS | Mode removed; passkeys are a runtime factor, exercised end to end in Chromium. |
| Primary login is passkey (UV required) or TOTP | PASS | `lib/auth/passkey.ts` `userVerification: "required"` + `requireUserVerification: true` on both ceremonies; `lib/auth/totp.ts`. |
| Session token 256 bits, DB stores a hash, `ok` rejected | PASS | `createSession` `randomToken(32)` / `sha256Hex`; `looksLikeSessionToken` rejects anything but 43 base64url chars. |
| Cookie `__Host-amexlens_session`, Secure, HttpOnly, Lax, Path=/ | PASS | `lib/auth/cookie.ts`; `test/auth/session.test.ts`. |
| Idle and absolute timeouts; logout deletes the row | PASS | `liveSession` (`now >= expires`, `now - lastSeen > 2 h`); `test/auth/session.test.ts` (idle, absolute, logout, rotate). e2e `session`. |
| Every state-changing handler checks Origin and a custom header | PASS | `requireMutation` → `assertCsrf` on: items DELETE, transactions PATCH/DELETE, cards refresh, data DELETE, exchange, link-token, consent, repair, sync (session path), auth/sessions DELETE, setup/recovery; `assertCsrf` alone on login/logout/setup bootstrap. e2e `csrf`. |
| Unauthenticated `/api/*` returns 401 JSON | PASS | `middleware.ts` and every handler. e2e `routes-401`, `redirects` ("never redirected to HTML"). |
| Each handler checks the session itself | PASS | Enumerated: `cards` GET, `cards/[id]/refresh` POST, `data` DELETE, `items` GET, `items/[id]` DELETE, `plaid/consent|exchange|link-token|repair` POST, `plaid/sync` POST (`authorizeSync`), `stats/currencies|totals|trend` GET, `system` GET, `transactions` GET, `transactions/[id]` PATCH/DELETE; `auth/sessions` DELETE and `auth/setup/recovery` POST (`requireMutation`); `auth/setup/*` (`authorizeSetup` = setup token while no factor exists, else `requireMutation`); `auth/status` GET reads the session for the recovery count only. `test/auth/routes-401.test.ts` imports every module and calls it without middleware. |
| Login `from` is an allowlisted relative path | PASS | `safeFrom`; `test/auth/from.test.ts`; e2e `browser`. |
| Rate limits on login, link, exchange, sync | PASS | Login 5/15 min lockout; link-token 10/h; exchange 10/h; sync 6/h per scope (cron 12/h); refresh 1/10 min per card; consent/repair 6/h per item; passkey options 30/min (RT-04). `test/http/rate-limit.test.ts`, `test/security/red-team.test.ts`. |

**Tokens and data at rest**

| Row | Verdict | Evidence |
|---|---|---|
| AES-256-GCM, random nonce, version prefix, AAD = item id | PASS | `lib/crypto.ts` (`v1.<iv>.<tag>.<ct>`, 12-byte IV, 16-byte tag); `test/lib/crypto.test.ts`. |
| Missing key refuses startup; plaintext column gone; VACUUM; old backups called out | PASS | `loadDataKey` in `assertBootConfig`; migration 0004; `createSqliteDB` runs `VACUUM`, checkpoints and logs the backup warning; `scripts/backup.mjs --purge-plaintext`. |
| DB 0600 / dir 0700 set in code | PASS | `hardenFileModes`. |
| Backups consistent, age-encrypted, key outside, restore run on a fixture | PASS | `scripts/backup.mjs` (online backup API, `.age`, 0600, temp file removed in `finally`), `scripts/restore-check.mjs`; `test/scripts/backup.test.ts` runs backup → restore-check → `verify-no-plaintext` on a fixture. Host drill: section 6. |
| FDE documented; VPS snapshot caveat | PASS | SECURITY.md 3.2 and the privacy panel state it. |
| No response/log/toast contains a token; planted-token test | PASS | `test/lib/log.test.ts`, `test/http/revoke.test.ts`, `test/http/exchange.test.ts` (`plaidError` plants tokens in `config.data` and `error_message`); e2e checks the server log and HTML for token shapes. |

**Aggregator**

| Row | Verdict | Evidence |
|---|---|---|
| One provider | PASS | `lib/providers/index.ts`. |
| Scopes: liabilities + transactions, credit cards, country CA | PASS after RT-08 | `lib/plaid.ts`; default `PLAID_COUNTRY_CODES` was `US,CA` (now `CA`). |
| Issuer password never hits a route | PASS | No such field anywhere; Link widget only. |
| Persisted fields are an allowlist; account-number fixture absent | PASS | `test/cards/refresh-allowlist.test.ts`. |
| Institution name from the provider | PASS | `exchange/route.ts`. |
| Revoke first; failure keeps credential, surfaces error, audits | PASS | `lib/items/revoke.ts`; residual RT-11. |
| `client_user_id` random per install | PASS | `lib/plaid-user.ts`. |
| Sandbox cannot boot with production keys and the reverse | DEFER | Not checkable: Plaid secrets carry no environment marker; `PLAID_ENV` only selects the API host. The code refuses the combinations it can see (`none` in production, http origin / insecure cookie / http redirect URI with `PLAID_ENV=production`). Operational control: separate env files per environment. |
| Overview shows `last_synced_at`; balances not client-writable | PASS | `components/CardTile.tsx` ("Synced … · Refreshed …"), `FieldValue` tooltips carry `observed_at`; no write route. |

**Webhooks and sync**

| Row | Verdict | Evidence |
|---|---|---|
| No webhook → no public route but health; pull-only | PASS | e2e route enumeration. |
| Webhook rules / Plaid verification | N/A | None implemented. |
| Sync serialised per item; cursor after success | PASS | `withItemLock`, `casUpdateCursor`; mutation restart bounded at 3 attempts from the original cursor. |
| Cron does not send the user password | PASS | `CRON_SECRET` bearer; `scripts/sync.mjs`. |
| Provider HTTP outside write transactions | PASS | see P-D2. |

**Privacy**

| Row | Verdict | Evidence |
|---|---|---|
| Settings names processor, data elements, country | PASS | `components/PrivacyPanel.tsx`; e2e `data-privacy`. |
| Delete-card and delete-all exist; delete-card revokes | PASS | `DELETE /api/items/:id`, `DELETE /api/data` (revoke every item first). |
| No claim that the provider deleted its copy | PASS | Panel and DangerZone text. |
| Incident steps still accurate | DEFER to WP8 | Docs task. Note for it: "rotate the session secret" is now "delete every row in `sessions`" (`DELETE /api/auth/sessions` or SQL). |

**Browser, headers, supply chain, deploy**

| Row | Verdict | Evidence |
|---|---|---|
| Section 3.10 headers on HTML and `/api/*` | PASS | `next.config.mjs` + `middleware.ts`; e2e `headers` (HTML, API, 404, static). HSTS: runtime flag (RT-06). |
| CSP without `'unsafe-inline'`/`'unsafe-eval'` in `script-src`; Plaid the only third-party host | PASS | `lib/security-headers.mjs`; per-request nonce from `crypto.getRandomValues(16)`; `img-src 'self' data:`; `frame-src https://cdn.plaid.com`; `'strict-dynamic'` deliberately absent (documented in the file). No CSP violations in Chromium (e2e). |
| `logo_url` not rendered or allowlisted | PASS | Stored only; no `<img src={logo_url}>` and no `dangerouslySetInnerHTML` anywhere in `app/`, `components/`, `lib/`. |
| Lockfile, patched Next, `npm audit --audit-level=high` | PASS | `package-lock.json`; `next@15.5.28`; audit at high: 0 (14 moderate in `eslint-plugin-*` dev deps via `minimatch`; `--omit=dev`: 0). Dependabot config present; Semgrep/Trivy/gitleaks jobs exist (non-blocking). |
| Listens on 127.0.0.1; TLS/HSTS on the proxy; not `next dev` | PASS | `package.json` `start`/`dev` pass `-H 127.0.0.1`; e2e server binds the same way. |
| Unprivileged user; secrets 0600 | PASS / host | `TOKEN_ENCRYPTION_KEY_FILE` mode is checked and warned on (`lib/crypto.ts`); the rest is deployment documentation. |

**Tests the PR must include**

| Row | Where |
|---|---|
| 401 without a session on items, transactions, stats, link-token, exchange, sync, disconnect, system | `test/auth/routes-401.test.ts` (handlers) and `test/e2e/routes-401.e2e.ts` (HTTP) |
| `amexlens_auth=ok` is not a session | both of the above |
| Forged webhook changes zero rows | N/A (no webhook) |
| Two concurrent syncs cannot persist an older cursor | `test/lib/sync-hardening.test.ts` |
| Revoke failure does not delete the encrypted token | `test/http/revoke.test.ts` |
| Redaction test for logs and error JSON | `test/lib/log.test.ts`, `test/http/revoke.test.ts`, `test/http/exchange.test.ts` |
| Allowlist test: account number absent from the DB | `test/cards/refresh-allowlist.test.ts` |

### 3.4 Probes that found nothing (kept for the record)

- **Token leakage grep.** Every `access_token` use is a provider call argument or the encrypted-column boundary; `public_token` only goes browser → `exchange`; `link_token` is returned once to the browser (it must be) and never logged; `error_message` is only mentioned in comments; no `console.` in `app/`/`lib/`/`components/` (scripts use their own redacting logger); no `res.text()` of a provider body anywhere.
- **`redact()` edge cases.** Axios config headers (`PLAID-SECRET`, `Authorization`), `config.data` strings holding a token, nested arrays of errors, `Error.cause` (dropped with the Error reduction), depth > 6 (`"[depth]"`). A secret that is neither Plaid-shaped nor under a sensitive key (e.g. a bare `CRON_SECRET` inside a message) would pass; nothing logs such a message today.
- **Session fixation.** Login always rotates a presented token (`issueSessionCookie`); exchange, consent, repair, disconnect and delete-all rotate (`rotateSessionOnResponse`); a cookie set cross-site cannot carry the `__Host-` name.
- **Setup routes.** `AUTH_SETUP_TOKEN` is consulted only while zero factors exist, compared in constant time, under its own lockout scope; after the first factor every setup route needs a session + CSRF; unset token = nobody can enrol (fail closed). TOTP `totp_last_step` is persisted in `auth_state`, so replay protection survives a restart.
- **Passkeys.** Challenge rows are single-use via a transaction, 5-minute TTL, kind-bound (`reg` vs `auth`); `rpID`/`expectedOrigin` from `APP_ORIGIN` only; `excludeCredentials` on registration; counter regression rejected before the counter is persisted.
- **Middleware prefixes.** `/login`, `/login/…`, `/api/auth/…`, `/api/health` (exact), `/plaid/oauth` (exact), `/_next/…`, `/favicon.ico`, and `POST /api/plaid/sync` only when an `Authorization` header is present (then the handler demands the exact bearer). Look-alikes and encodings tested in `redirects.e2e.ts`. Forged `Host` / `X-Forwarded-Host` never reaches the redirect target (RT-09 probe).
- **Rate limits before auth.** None: every `rateLimited` call sits after `requireMutation`/`authorizeSync`; the only pre-auth limiter is the lockout (and now the passkey-options bucket), both on fixed scopes.
- **Sync.** `withItemLock` is not re-entrant and `refreshItemCards` is documented and used accordingly (sync calls it inside the lock; routes wrap it). CAS conflict is logged, not retried, and the next sync catches up. `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts from the original cursor at most twice (3 attempts) with idempotent upserts.
- **Encryption.** `DecryptError` messages are fixed strings; `TokenUnreadableError` carries the item id only; `DataKeyInvalidError` never echoes the key; the key-file mode warning fires once.
- **Backup script.** The only plaintext on disk is the online-backup snapshot in `BACKUP_DIR` (0700, umask 077) between `db.backup()` and the `finally` that removes it and its `-wal/-shm/-journal`; `verify-no-plaintext` walks every file under `data/` including `-wal`/`-shm`.
- **Client.** `apiFetch` only surfaces `SAFE_CODE`-shaped codes; the Plaid Link token lives in `sessionStorage` for ≤ 30 minutes and is cleared on success/exit; `/plaid/oauth` can only re-open Link with a token this origin stored (no URL parameter is trusted).

## 4. Findings

| ID | Severity | Finding | Status | Commit |
|---|---|---|---|---|
| RT-01 | Medium | No request-body limit on any JSON route, including the unauthenticated login and setup routes: `req.json()` buffers an arbitrarily large (or chunked, length-less) body in memory. Repro: `POST /api/auth/login/totp` with a 1 GiB body from any host that can reach the port. | Fixed: `lib/http/body.ts` (64 KiB, Content-Length check then streaming cut-off, 413 `payload_too_large`); applied to every body-reading handler; oversized posts no longer count as login failures. Tests: `test/security/red-team.test.ts`, e2e `params-bodies`. | `0a66af4` |
| RT-02 | Medium (availability) | The login lockout is keyed by scope only (by design, see `lib/auth/lockout.ts`): five bad codes from anywhere lock TOTP, passkey and recovery sign-in for 15 minutes, repeatable forever. An unauthenticated remote can keep the owner out of a reachable instance. | Deferred, documented. It is the stated trade-off (X-Forwarded-For is attacker-controlled; one user). Mitigations: Tailscale/private bind, proxy-level per-IP limit, and the fact that an already-open session is unaffected. A per-source secondary bucket keyed on the proxy's trusted `X-Real-IP` would be the next step. | — |
| RT-03 | Low | No route or UI to remove an enrolled passkey (`passkeys` has `deletePasskey` in the repo but nothing calls it). A lost or stolen authenticator cannot be revoked without SQL. | Deferred: needs `GET/DELETE /api/auth/passkeys[/:id]` behind `requireMutation` plus a settings list; recovery codes and "sign out everywhere" exist meanwhile. | — |
| RT-04 | Low | `POST /api/auth/login/passkey/options` (unauthenticated) wrote a challenge row and returned the credential-id list per call, bounded only by the 5-minute purge. | Fixed: 30/min after the lockout check. | `6eb7b18` |
| RT-05 | Low | `GET /api/auth/status` told anonymous callers how many recovery codes remain. | Fixed: `null` without a valid session; Settings (which has one) still sees the number. | `6eb7b18` |
| RT-06 | Low (availability) | Production CSP always carried `upgrade-insecure-requests`; on the documented plain-http LAN/Tailscale deployment (`COOKIE_INSECURE_DEV=1`, non-loopback IP) browsers upgrade every same-origin asset to https and the app does not load. `ENABLE_HSTS` was evaluated at build time in `next.config.mjs`. | Fixed: `buildCsp({ upgrade })` driven by `APP_ORIGIN` scheme in middleware; HSTS set at runtime by middleware on every response. | `22b9e74` |
| RT-07 | Low | `PLAID_REDIRECT_URI` accepted any http(s) origin. The Link token is held in this origin's sessionStorage, so a foreign redirect URI could never finish the flow and would hand the issuer's `oauth_state_id` to another host. | Fixed: boot refuses a redirect URI whose origin differs from `APP_ORIGIN`. | `8b01099` |
| RT-08 | Low | Docs-vs-code drift: default `PLAID_COUNTRY_CODES` was `US,CA` (SECURITY.md 3.5/F-16 say CA); no `security_log` row for a successful exchange (3.6/C-R1); rate-limit and lockout trips were not logged as events (3.6). | Fixed. | `387adc2` |
| RT-09 | Medium (availability) / Low (security) | The unauthenticated page redirect was built from `req.nextUrl`, which Next derives from the server's bind hostname (`localhost` when bound to 127.0.0.1) and from `X-Forwarded-Proto`. Behind the documented 127.0.0.1 + reverse-proxy deployment every anonymous page visit was sent to `http://localhost:3000/login?…`. Probe: `curl -H 'Host: cards.example' -H 'X-Forwarded-Proto: https' …/transactions` → `location: http://localhost:3140/login…` before, `https://cards.example/login…` after. A forged `Host` was never reflected (good). | Fixed: target built on `APP_ORIGIN`; Next still rewrites loopback IPs to `localhost` in any Location (`next-url.js`), which only affects same-machine access. Tests: `test/auth/middleware.test.ts`, e2e `redirects`. | `386a17f` |
| RT-10 | Low | WebAuthn refuses an IP-address RP ID, so passkeys cannot be enrolled or used when `APP_ORIGIN` is `http://127.0.0.1:…` or a bare LAN/Tailscale IP; those deployments are TOTP + recovery only, with no error more helpful than "Could not add a passkey". | Deferred (documentation): use a hostname (MagicDNS, `localhost`, or the proxy name). The e2e browser suite runs on `http://localhost:3134` for this reason. | — |
| RT-11 | Low | An item whose ciphertext cannot be decrypted (data key lost or rotated without re-encryption) can never be revoked (`CREDENTIAL_UNREADABLE` → `revoke_failed`) and therefore never deleted locally; `DELETE /api/data` then fails with `revoke_incomplete` forever. | Deferred: needs an explicit, audited "forget locally without revoke" action for `revoke_failed` items (the owner revokes in the Plaid dashboard). | — |
| RT-12 | Info | `refreshItemCards` replaces every stored field observation on each refresh; when `/liabilities/get` fails transiently, previously `present` liability values become `error` observations until the next success (last-known values are not kept). Balances/limits are untouched when the accounts call fails. | Policy, documented. The UI shows the gap with its reason and `observed_at`; keeping the last good value would need a "stale" status. | — |
| RT-13 | Info | `security_log` grows without bound (one `cards_refresh` row per sync/refresh, ~12 per hour per item under cron). | Deferred: retention/prune job or a cap in the delete-all path. | — |
| RT-14 | Info | Session rotation on link/disconnect/delete-all mints a fresh 12-hour session, so the "absolute lifetime" restarts on those actions (not on ordinary requests). | Documented; acceptable for one owner. | — |
| RT-15 | Info | Once a factor exists, the setup routes check the session (401) before CSRF (403). Fail-closed either way. | Documented; e2e asserts the order. | — |
| RT-16 | Info | `next.config.mjs` `headers()` is evaluated at build time: the static `/api/*` CSP's `connect-src` host follows the `PLAID_ENV` of the build, not the deploy. API responses are JSON, so this has no effect; the HTML CSP is computed per request in middleware. | Documented. | — |
| RT-17 | Info | Residuals already stated by WP2 and re-confirmed: in-memory lockout and rate-limit state reset on restart; recovery codes are unsalted SHA-256 of 50-bit random codes (offline guessing needs the DB, which also holds the ciphertext an attacker would rather have). | Documented. | — |

No Critical or High finding. Nothing in the deferred list is in the non-deferrable set of SECURITY.md §5 (F-01, F-02, F-03, F-04, F-06, webhook verification, scope limits).

## 5. Docs-vs-code: what SECURITY.md §3 asks for that the code does not do (for WP8)

1. **3.1 "Production boot refuses `PLAID_ENV=sandbox`" / §5 "Sandbox cannot boot with production keys and the reverse".** Not implementable: Plaid secrets have no environment prefix. Record as uncheckable; the operational control is separate env files and DB files per environment (3.9 already says so).
2. **3.6 "sync start/end" as security-log events.** Sync end is a redacted log line (`sync_finished`, counts only); there is no `security_log` row. Record as deferred (a row per cron run would grow the table, see RT-13).
3. **3.3 "Rate limit … Webhook 60/min"** and all of **3.4**: no webhook exists; mark N/A rather than unchecked.
4. **3.9 host controls** (systemd hardening, firewall, NTP, unprivileged user, read-only checkout) are documentation, not code; keep them in the deploy runbook.
5. **P-D2 timeout on provider calls.** The Plaid SDK client is created without an axios timeout; a hung provider connection holds the per-item lock (not a DB transaction) until the socket dies. Record as deferred (set `baseOptions.timeout`).
6. **Incident runbook step 3** ("rotate the session secret"): there is no session secret; the equivalent is `DELETE /api/auth/sessions` or `DELETE FROM sessions`.
7. **3.5 country default** and **3.6 exchange audit / rate-limit events** were drift and are now code (RT-08).

## 6. Manual items still open

- **Plaid Link under the CSP with real sandbox keys.** The nonce'd `script-src` allows `https://cdn.plaid.com`, `frame-src` allows it, `connect-src` allows the sandbox host; this has not been exercised with a real Link session in CI (no keys). Run the browser flow once with sandbox keys and watch the console for CSP reports.
- **Issuer OAuth popup under `Cross-Origin-Opener-Policy: same-origin-allow-popups`.** Confirm one OAuth institution round-trips through `/plaid/oauth` with `PLAID_REDIRECT_URI` registered.
- **Backup restore drill on the real host.** `npm run backup && AGE_IDENTITY_FILE=… npm run restore:check -- data/backups/<file>.age && npm run verify:no-plaintext` with the real age identity kept off the host; the fixture drill runs in `test/scripts/backup.test.ts`.
- **Passkey on a real authenticator over https** with the production `APP_ORIGIN` hostname (RT-10), and HSTS turned on at the proxy once TLS is live (`ENABLE_HSTS=1` is now honoured at runtime).
- **Per-IP throttle at the proxy** for `/api/auth/login/*` to blunt RT-02 on an internet-reachable instance.

## 7. Gate

Run on this branch after the fixes: `npm run typecheck` ✓, `npm run lint` ✓, `npm test` ✓ (50 files, 453 tests), `npm run test:e2e` ✓ (10 files, 150 tests), `npm audit --audit-level=high` ✓ (0 high; 14 moderate in dev-only eslint plugins), `PLAID_CLIENT_ID=x PLAID_SECRET=x npm run build` ✓.
