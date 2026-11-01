# Handover: AmexLens (amexLink) → Claude

Prepared Oct 30, 2026 for Pamimo Akinjide (owner, World's Edge Group, Toronto). Reconciled with the built system on Oct 31, 2026 (WP8). Read this first, then `docs/SECURITY.md` (mandatory bar, checklist ticked against the code), `docs/RED-TEAM.md` (the independent attacker pass), then `docs/ARCHITECTURE.md` and `docs/data-providers.md` (verified 2026-10-30; status banner at the top of each).

Nothing described below as "built" is on `main` yet: it lives on the stacked branches in section 12 (PRs #5 to #23, plus this one) and lands by merging them in order.

## 1. Purpose and owner goals

**AmexLens** is a self-hosted Next.js 15 + Plaid + SQLite app. It started as a spending dashboard and is now a **one-screen overview of ALL the owner's credit cards**, showing per card:

- current balance, statement balance, credit limit, available credit, utilization (computed, labeled as such)
- minimum payment, next due date, last payment (amount + date), APR(s) including penalty APR, overdue flag
- sorted by soonest due date; cards due within 7 days highlighted; overdue first
- totals (per currency; never add CAD and USD together)

Hard requirements (all still in force):

- **Data is pulled automatically from reputable aggregation APIs. No manual entry or overrides.** If a provider cannot supply a field, the UI says so for that field (e.g. "Plaid does not support this field at this institution").
- **Provider abstraction**: a `CardProvider` interface so a second provider can fill gaps; per-field provenance (provider, status, observed_at).
- Owner is in **Toronto, Canada**: Canadian issuers (Amex Canada, RBC, TD, BMO, CIBC, Scotiabank, etc.) matter most. `PLAID_COUNTRY_CODES` defaults to `CA`; add `US` explicitly for a US-issued card.
- **Architecture first**, then build. The security review (`docs/SECURITY.md`) and the red-team pass (`docs/RED-TEAM.md`) are done; every change must keep the SECURITY.md checklist passing.
- Possibly published on the **Apple App Store** later (undecided, section 8).

## 2. Current state of the code (on the `wp*` stack, top = `wp9-red-team`; `main` is still the original app)

What the stack does:

- **Auth.** Server-side sessions (`__Host-amexlens_session`, 12 h absolute / 2 h idle, rotated on sign-in and on link/disconnect/delete-all). First-run setup on `/login` with `AUTH_SETUP_TOKEN`: TOTP enrolment, 10 single-use recovery codes, optional passkey (WebAuthn, user verification required). No password. `AUTH_MODE` is `required` (default) or `none` (refused in production). Every handler checks the session itself; middleware is only a convenience gate. CSRF: `Origin`/`Referer` must match `APP_ORIGIN` plus `X-AmexLens-Request: 1`. 5 failures per 15 minutes locks sign-in (in-memory, global).
- **Secrets and data at rest.** Plaid access tokens and the TOTP secret are AES-256-GCM ciphertext under `TOKEN_ENCRYPTION_KEY` (required at boot, never auto-generated). DB dir `0700`, files `0600`. Consistent, age-encrypted backups (`npm run backup`), restore drill, plaintext scanner. Transactions and liability values are **not** column-encrypted (full-disk encryption is mandatory).
- **Plaid.** Link token modes `new | consent | repair`; products `transactions` + `required_if_supported_products: [liabilities]`, credit cards only, update mode for consent/re-login, OAuth return page `/plaid/oauth`. Revoke-then-delete disconnect. Sync is serialized per item with cursor compare-and-set; cron via `CRON_SECRET` bearer. Pull-only: **no webhook**.
- **Cards.** `lib/providers/plaid.ts` adapter writes one observation per field (`present | not_supplied | not_supported | consent_required | error` with provider and `observed_at`); `lib/cards/{merge,urgency,refresh,view}.ts` merge, rank (America/Toronto dates) and total per currency. Balances are cached on sync; the billed `/accounts/balance/get` runs only on an explicit per-card refresh.
- **UI.** `/` is the cards overview (urgency banner, per-currency totals, card tiles with gap text), `/spending` the old dashboard, `/transactions`, `/settings` (items, consent/reconnect, factors, privacy panel, delete all local data), `/login`.
- **Hardening.** Nonce CSP (no `'unsafe-inline'`/`'unsafe-eval'` in `script-src`, `'strict-dynamic'` deliberately omitted), HSTS at runtime when `ENABLE_HSTS=1`, 64 KiB JSON body cap, redacting JSON logger, safe `{error:{code}}` bodies, `next@15.5.28`, lockfile, CI with audit and an e2e attacker suite.

Gate on the top of the stack: 50 unit test files / 453 tests, e2e 10 files / 150 tests, typecheck, lint, build and `npm audit --audit-level=high` green.

File map:

| Path | Role |
|---|---|
| `app/page.tsx` | Cards overview (home) |
| `app/spending/page.tsx`, `app/transactions/page.tsx`, `app/settings/page.tsx` | Spending dashboard, transactions table, settings (items, factors, privacy, danger zone) |
| `app/login/page.tsx`, `app/plaid/oauth/page.tsx` | First-run setup and sign-in; Plaid OAuth return page |
| `app/api/auth/{status,logout,sessions}`, `app/api/auth/setup/*`, `app/api/auth/login/*` | Auth routes (TOTP, passkey, recovery, setup) |
| `app/api/plaid/{link-token,exchange,sync,consent,repair}/route.ts` | Link token modes, exchange, sync, consent and repair finish steps |
| `app/api/cards/route.ts`, `app/api/cards/[id]/refresh/route.ts` | Overview data; the only billed balance call |
| `app/api/items/*`, `app/api/transactions/*`, `app/api/stats/{totals,trend,currencies}`, `app/api/data/route.ts`, `app/api/system/route.ts`, `app/api/health/route.ts` | Items, transactions, per-currency stats, delete all local data, operator detail (session), public `{ok}` probe |
| `middleware.ts`, `instrumentation.ts` | Nonce CSP + cookie-shape gate; boot checks (exit 1 on refusal) |
| `lib/auth/*` | `session`, `guard` (CSRF), `cookie`, `totp`, `passkey`, `recovery`, `lockout`, `from`, `factors`, `mode` |
| `lib/crypto.ts`, `lib/boot.ts`, `lib/env.ts`, `lib/log.ts`, `lib/audit.ts`, `lib/errors.ts` | Data key core, boot refusals, env validation, redacting logger, `security_log` writer |
| `lib/plaid.ts`, `lib/plaid-user.ts`, `lib/providers/{types,plaid,plaid-fields,index}.ts` | Plaid client + least-privilege scopes, per-install `client_user_id`, `CardProvider` adapter and field pickers |
| `lib/cards/{merge,urgency,refresh,view}.ts` | Merge on read, Toronto-date urgency, refresh hooked into sync, API view |
| `lib/transactions.ts`, `lib/sync/{lock,authorize}.ts`, `lib/items/revoke.ts`, `lib/categorize.ts` | Sync loop, per-item mutex and cron/session authz, revoke-then-delete, bucket rules |
| `lib/http/{body,errors,params,rate-limit}.ts`, `lib/client/{api,plaid-link}.ts` | Body cap, safe errors, query parsing, limiters; browser fetch wrapper and Link session |
| `lib/security-headers.mjs`, `next.config.mjs` | Header set and CSP builder |
| `lib/db.ts`, `lib/db/sqlite/*.ts`, `lib/db/migrations/` | DB interfaces (per-area repos), SQLite impl; migrations 0001 init, 0002 core, 0003 auth, 0004 token_ct (code step), 0005 item_status, 0006 card_liabilities |
| `components/*` | UI: `CardTile`, `FieldValue`, `CurrencyTotals`, `UrgencyBanner`, `AuthSettings`, `ItemActions`, `PrivacyPanel`, `DangerZone`, charts |
| `scripts/{sync,backup,restore-check,verify-no-plaintext,verify-sandbox,key-generate}.mjs`, `scripts/log.mjs` | Cron sync, encrypted backup, restore drill, plaintext scan, sandbox verifier, key generator |
| `test/**` | Unit/integration suites (`npm test`) and the e2e attacker suite (`test/e2e`, `npm run test:e2e`) |
| `.github/workflows/{ci,security-scans}.yml`, `.github/dependabot.yml` | CI (typecheck, lint, test, audit, build, e2e), non-blocking scans, Dependabot |
| `docs/SECURITY.md`, `docs/RED-TEAM.md`, `docs/ARCHITECTURE.md`, `docs/data-providers.md` | Threat model + ticked checklist, red-team report, system design, provider research |

## 3. What has been done

One line per work package, with its PR (each stacks on the previous; section 12):

1. **Security review** (Cursor agent, PR #3) and **provider research + architecture** (Cursor builder, Oct 30; its code was lost, its docs were salvaged and have since been verified). Headline conclusion, verified 2026-10-30: **primary Plaid** (Transactions + Liabilities + cached/billed Balance); Liabilities requested via `required_if_supported_products`; Plaid's 2026-10-16 coverage CSV flags Liabilities on for Amex Canada (`ins_100533`), RBC, TD, BMO, CIBC, Scotiabank, National Bank, Tangerine, Canadian Tire, off for Desjardins, PC Financial, Simplii, Vancity Visa, EQ, KOHO, Wealthsimple; gap-filler if ever needed is Yodlee (enterprise contract), not Flinks.
2. **WP0 #5** foundation: `next@15.5.28` pinned, lockfile, Node 22, vitest, CI, DB/client seams, `randomUUID` ids, bind `127.0.0.1`.
3. **WP1 #7** crypto core: AES-256-GCM `v1.` ciphertext with AAD, `npm run key:generate`, boot refuses without a 32-byte key.
4. **WP3 #9** at rest: migration 0004 moves tokens to `access_token_ct`, `VACUUM`, file modes, redacting logger, age-encrypted backups, restore drill, plaintext scanner.
5. **WP4 #10** revoke, errors, health, sync hardening: revoke-then-delete, safe error bodies, `/api/health` = `{ok}` + `/api/system`, per-item lock with cursor CAS, `CRON_SECRET`, rate limits, LIKE escaping.
6. **WP6a #13** provider adapter and liabilities data: `CardProvider`, field pickers/allowlist, migration 0006, merge/urgency/refresh/view, `GET /api/cards`, `POST /api/cards/[id]/refresh`, Link scopes with `assertLeastPrivilege`, per-install `client_user_id`.
7. **WP2 #15** auth and sessions: server-side sessions, TOTP + passkeys + recovery codes, `requireSession`/`requireMutation`, CSRF, lockout, `safeFrom`, setup/login UI, boot refusals. Closes F-01, F-02, F-04, F-05, F-10, F-15.
8. **WP7b #16** per-currency stats: `byCurrency` responses, `/api/stats/currencies`, Toronto month keys.
9. **WP5a #17** response headers and static CSP per SECURITY.md 3.10.
10. **WP5b #18** per-request CSP nonce, `'unsafe-inline'` removed from `script-src`.
11. **WP6b #21** link modes, consent, repair, OAuth resume page, `PLAID_REDIRECT_URI`, `npm run verify:sandbox`.
12. **WP7 #22** cards overview home, `/spending`, privacy panel, `DELETE /api/data`.
13. **WP9 #23** red-team pass: 150-test e2e attacker suite (built server + Chromium), RT-01, 04, 05, 06, 07, 08, 09 fixed, the rest recorded in `docs/RED-TEAM.md`. No Critical or High finding.
14. **WP8 (this PR)** docs sync: SECURITY.md checklist ticked against the code (43 of 49 rows, 3 N/A, 3 deferred, plus four open items), finding statuses, residual risks, and HANDOVER, ARCHITECTURE, data-providers, README and CLAUDE.md reconciled with the code.

Superseded and closed PRs: #6, #8, #11, #12, #14, #19, #20 (their work is in the `-rebased` / re-stacked branches).

## 4. What is NOT done

- **Nothing is merged to `main`.** `main` is still the original Transactions-only app. Merge the stack in order (section 9).
- **No real Plaid run.** All Plaid behavior is tested against fixtures and fakes. The sandbox run (`npm run verify:sandbox -- --coverage ins_100533`, then the full browser flow) and a Trial/Production run with real cards have not happened; no keys are in CI.
- **Browser verification still owed:** Plaid Link under the nonce CSP (script, frame and connect hosts), and the issuer OAuth popup under `Cross-Origin-Opener-Policy: same-origin-allow-popups` through `/plaid/oauth`. Also a passkey on a real authenticator over https with the production hostname.
- **Backup restore drill on the real host** with the real age identity (kept off the host). The fixture drill runs in `test/scripts/backup.test.ts`.
- **Reminders** (ntfy/email) are not built. The banner and the `npm run sync` summary line are the only notifications.
- **Webhook** is not built (design kept in SECURITY.md 3.4 and ARCHITECTURE.md). Sync is pull-only.
- **Yodlee adapter** is not built; justified only if a card the owner holds comes back `not_supported`.
- **Deferred red-team and checklist items** (`docs/RED-TEAM.md` section 4, `docs/SECURITY.md` sections 5 and 8): RT-02 per-source secondary lockout bucket (use a proxy-level per-IP limit meanwhile), RT-03 passkey list/remove, RT-10 passkeys need a hostname RP ID (docs only), RT-11 audited "forget locally" for undecryptable items, RT-13 `security_log` retention, P-D2 Plaid client timeout, sync start/end audit rows, the uncheckable sandbox-versus-production key check, and column encryption of transaction amounts / liability values or SQLCipher.
- **Repository settings:** making the CI jobs required checks is an owner setting on GitHub.
- **Next 16** upgrade (S-sized, later); `next@15.5.28` is the security-backport line.
- **App Store / multi-user / iOS** (section 8).

## 5. Security bar (mandatory)

`docs/SECURITY.md` is the acceptance bar and `docs/RED-TEAM.md` is the evidence; every PR must keep the section 5 checklist passing. State as built: all 20 original findings (F-01 to F-20) are closed (SECURITY.md 4.1 has the per-finding status and PR); the non-deferrable set (F-01, F-02, F-03, F-04, F-06, webhook verification, scope limits) is ticked, with webhook verification N/A because no webhook exists. The remaining open items and residual risks are SECURITY.md sections 5 (unticked rows) and 8.

## 6. Architecture (as built)

`CardProvider` adapters → per-field observations (`account_fields`: field, provider, status ∈ present/not_supplied/not_supported/consent_required/error, observed_at, error_code) → `mergeCards` on read (present beats missing; then provider priority plaid > yodlee > mx > flinks) → `GET /api/cards` → UI. Pull-only sync; AES-256-GCM encryption of tokens and the TOTP secret; sessions + TOTP/passkey; no manual-entry columns. Urgency is computed on America/Toronto dates. Details and the "future" items are in `docs/ARCHITECTURE.md`.

## 7. Phased build plan

- **Phase 0 – Security fixes: DONE** (WP0, WP1, WP3, WP4, WP2, WP5a, WP5b; PRs #5, #7, #9, #10, #15, #17, #18).
- **Phase 1 – Provider adapter + liabilities: DONE** (WP6a #13, WP6b #21 incl. `verify:sandbox`). Real-sandbox verification: OPEN (owner action).
- **Phase 2 – Overview UI + reminders:** overview, urgency sort, 7-day highlight, per-currency totals, gap labels, privacy/delete-all: DONE (WP7 #22, WP7b #16). Banner + sync summary: DONE. **ntfy/email reminders: OPEN** (no account numbers or amounts in the body by default).
- **Phase 3 – Red-team pass: DONE** (WP9 #23); the manual items in section 4 and the deferred RT items: OPEN.
- **Phase 3b – Docs sync: DONE** (WP8, this PR).
- **Phase 4 (optional) – Multi-user / iOS:** OPEN, only if the owner chooses App Store publication.

## 8. Decisions

Resolved:

1. **Personal-only** (not App Store). Phase 4 stays closed unless this changes. Publishing would imply multi-user accounts and tenant isolation, a hosted backend (Postgres, not local SQLite), an iOS client, an Apple Developer **organization** account for World's Edge Group (US$99/yr, needs a free D-U-N-S number), aggregator **production** approval, privacy policy/terms/data deletion, **PIPEDA** compliance, App Store privacy labels and a reviewer demo account.
2. **Auth: TOTP and passkey**, with recovery codes. No password.
3. **Primary provider: Plaid.**

Still open (owner):

4. Pay for a gap-filler (Yodlee) only if a card he actually holds comes back `not_supported`.
5. Hosting: homelab/VPS + Tailscale or a private bind (recommended; enough for the pull-only design) vs public HTTPS (needed only for a future webhook). A passkey needs a hostname origin, not a bare IP.

## 9. Owner-action checklist (Pamimo)

- [ ] **Merge order.** Merge bottom-up: #5 → #7 → #9 → #10 → #13 → #15 → #16 → #17 → #18 → #21 → #22 → #23 → WP8 (this PR). Each PR targets its predecessor; after each merge point the next PR's base at `main` (GitHub does it automatically if the merged branch is deleted). Do not merge `claude/swift-analysis-rebuild-6Y7xV`.
- [ ] Create a Plaid account (dashboard.plaid.com), get `PLAID_CLIENT_ID` + the sandbox secret; never paste secrets into chat or commits.
- [ ] In the dashboard enable **Transactions, Liabilities, Balance** only; leave Auth, Identity, Investments, Transfer, Signal off.
- [ ] Apply for Trial or Production access incl. **Liabilities**; check the pricing shown in the dashboard. The Trial Item cap (10) is lifetime: deleting an Item does not free a slot, so do not burn Items on test re-links.
- [ ] Register `PLAID_REDIRECT_URI` in the Plaid dashboard (sandbox `http://localhost:3000/plaid/oauth`; production exact HTTPS, no query or fragment) and set the same string in `.env.local`. It must be on `APP_ORIGIN`. Whether a Canadian issuer uses OAuth is probed, not assumed.
- [ ] Generate and store in a password manager: `TOKEN_ENCRYPTION_KEY` (`npm run key:generate`; losing it means re-linking every card), `AUTH_SETUP_TOKEN` (`openssl rand -base64 32`), `CRON_SECRET` (`openssl rand -base64 32`), and an age keypair (`age-keygen`; put only the public key in `BACKUP_AGE_RECIPIENT`, keep the identity off the server).
- [ ] Run `npm run verify:sandbox -- --coverage ins_100533` with sandbox keys (add `--with-liabilities`; see README "Sandbox verifier").
- [ ] First-run setup: start the app, open `/login`, paste the setup token, scan the TOTP QR, save the 10 recovery codes, add a passkey (needs a hostname origin). Then delete or rotate `AUTH_SETUP_TOKEN`.
- [ ] Do the browser checks in section 4: link a sandbox card through Plaid Link under the CSP (watch the console), and one OAuth institution through `/plaid/oauth`.
- [ ] Deploy per README "Deployment": bind `127.0.0.1`, TLS at the proxy, HSTS, systemd hardening, full-disk encryption, backups copied off the box, Tailscale or a proxy-level per-IP limit on `/api/auth/login/*`. Run `npm run backup && npm run restore:check` once with the real identity.
- [ ] Decide the open decisions in section 8.
- [ ] Optional: share a PC folder via Remote Control (Claude desktop app, Settings, Claude Code, Remote Control, or `claude remote-control` in the folder) if you want a Claude session to exercise Plaid Link in a real local browser.
- [ ] Optional: make the CI jobs required checks in the repository settings.
- [ ] If App Store: get D-U-N-S for World's Edge Group, enroll in Apple Developer Program as an organization.

## 10. Run locally / sandbox

```bash
nvm use                                  # Node 22 (.nvmrc)
cp .env.example .env.local               # PLAID_CLIENT_ID, PLAID_SECRET (sandbox), PLAID_ENV=sandbox
npm run key:generate                     # prints TOKEN_ENCRYPTION_KEY=...; paste it over the empty line in .env.local
# in .env.local also set: APP_ORIGIN=http://localhost:3000
#   AUTH_SETUP_TOKEN=<32+ random chars>   CRON_SECRET=<32+ random chars>   BACKUP_AGE_RECIPIENT=age1...
npm ci
npm run dev                              # http://localhost:3000, bound to 127.0.0.1
```

Open `/login`: paste `AUTH_SETUP_TOKEN`, scan the QR with an authenticator app, save the recovery codes, optionally add a passkey (works on `localhost`). Then `/settings` → **Connect a card** → Plaid sandbox `user_good` / `pass_good` (MFA `1234` if asked). `npm run sync` triggers a sync from cron (needs `CRON_SECRET` and the running server); `npm run backup` writes an age-encrypted snapshot. `AUTH_MODE=none` exists only for a throwaway sandbox and is refused in production. Before pushing: `npm run typecheck && npm run lint && npm test && npm run test:e2e`. Full details in `README.md`.

## 11. Suggested next prompt for Claude

> You're continuing the AmexLens repo. Read `HANDOVER.md`, `CLAUDE.md`, `docs/SECURITY.md` (the ticked checklist is the acceptance bar), and `docs/RED-TEAM.md`. First, merge the stacked PRs #5 to #23 and the WP8 docs PR bottom-up, retargeting each to `main` and rerunning `npm run typecheck && npm run lint && npm test && npm run test:e2e` after the last merge. Second, I will give you Plaid sandbox keys: run `npm run verify:sandbox -- --coverage ins_100533`, then walk the first-run setup and a sandbox link in a browser, and report CSP console errors and whether the OAuth popup works under COOP; fix what breaks with tests. Third, start the reminders phase: ntfy (and optional email) notifications for overdue and due-within-7-days cards that reuse `dueUrgency` and put no account numbers or amounts in the message by default. Do not add any manual data-entry path. Do not commit secrets. Tell me which owner actions (keys, redirect URI, ntfy topic) you need from me.

## 12. Branches

The stack (each PR targets the previous branch; `wp8-docs` targets `wp9-red-team`):

`main` ← `wp0-foundation` (#5) ← `wp1-crypto-core` (#7) ← `wp3-at-rest` (#9) ← `wp4-hardening-rebased` (#10) ← `wp6a-liabilities-rebased` (#13) ← `wp2-auth-rebased` (#15) ← `wp7b-currency-stats-rebased` (#16) ← `wp5a-headers-rebased` (#17) ← `wp5b-csp-nonce` (#18) ← `wp6b-link-rebased` (#21) ← `wp7-overview-rebased` (#22) ← `wp9-red-team` (#23) ← `wp8-docs` (this PR)

- **Superseded, can be deleted after the merge:** `wp4-hardening`, `wp6a-liabilities`, `wp2-auth`, `wp7b-currency-stats`, `wp5a-headers`, `wp6b-link`, `wp7-overview` (closed PRs #6, #8, #11, #12, #14, #19, #20; their content is in the `-rebased` branches).
- `claude/swift-analysis-rebuild-6Y7xV`: pre-existing, untouched. It was salvaged from (AES-GCM, headers, CI ideas) but never merged and not part of the stack; review separately.
- `cursor/security-architecture-9150` and `handover/claude`: sources of `docs/SECURITY.md` and the original handover (PRs #3 and #4, already on `main`).
