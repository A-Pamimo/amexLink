# Handover: AmexLens (amexLink) → Claude

Prepared Oct 30, 2026 for Pamimo Akinjide (owner, World's Edge Group, Toronto). Read this first, then `docs/SECURITY.md` (mandatory bar), then `docs/ARCHITECTURE.md` and `docs/data-providers.md` (salvaged drafts, unverified).

## 1. Purpose and owner goals

Today the repo is **AmexLens**: a self-hosted Next.js 14 + Plaid + SQLite spending dashboard. The owner wants it to become a **one-screen overview of ALL his credit cards**, showing per card:

- current balance, statement balance, credit limit, available credit, utilization (computed, labeled as such)
- minimum payment, next due date, last payment (amount + date), APR(s), overdue flag
- sorted by soonest due date; cards due within 7 days highlighted; overdue first
- totals (per currency; never add CAD and USD together)

Hard requirements:

- **Data is pulled automatically from reputable aggregation APIs. No manual entry or overrides.** If a provider cannot supply a field, the UI says so for that field (e.g. "Not supported by Plaid at this institution").
- **Provider abstraction**: a `CardProvider` interface so a second provider can fill gaps; per-field provenance (provider, status, observed_at).
- Owner is in **Toronto, Canada**: Canadian issuers (Amex Canada, RBC, TD, BMO, CIBC, Scotiabank, etc.) matter most; keep `US,CA`.
- **Architecture first**, then build. A **security expert** review (done, `docs/SECURITY.md`) and a **red-team** pass (not done) are part of the process.
- Possibly published on the **Apple App Store** later (undecided, see Open decisions).

## 2. Current state of the code (on `main`)

What works: link a card via Plaid Link (Transactions product only), `/transactions/sync` with cursor, rule-based categorization into buckets with manual category override, monthly stacked trend, KPI tiles, item filter, settings page to disconnect, cron-style `npm run sync`, `npm run backup`.

What it does NOT do: no balances, limits, liabilities, due dates, APRs; no cards overview. Security is not production-grade (see section 5).

File map:

| Path | Role |
|---|---|
| `app/page.tsx` | Home: spending dashboard (KPIs, donut, trend) |
| `app/transactions/page.tsx`, `app/settings/page.tsx`, `app/login/page.tsx` | Pages |
| `app/api/plaid/{link-token,exchange,sync}/route.ts` | Plaid Link token, public-token exchange, transactions sync |
| `app/api/items/route.ts`, `app/api/items/[id]/route.ts` | List / disconnect Plaid items |
| `app/api/transactions/...`, `app/api/stats/{totals,trend}` | Data APIs for the UI |
| `app/api/auth/{login,logout}`, `middleware.ts` | Optional password gate (weak, see SECURITY.md) |
| `app/api/health/route.ts` | Health check |
| `lib/plaid.ts` | Plaid client |
| `lib/db.ts`, `lib/db/sqlite/*.ts`, `lib/db/migrations/` | DB interfaces (per-area repos), SQLite impl, schema + code migrations |
| `lib/transactions.ts`, `lib/categorize.ts` | Sync + bucket rules |
| `lib/env.ts` | Env validation |
| `components/*` | UI components |
| `scripts/sync.mjs`, `scripts/backup.mjs` | Cron sync, DB backup |
| `docs/SECURITY.md` | Threat model + findings + acceptance checklist |
| `docs/ARCHITECTURE.md`, `docs/data-providers.md` | Salvaged design + provider research (unverified) |

## 3. What has been done

1. **Security review** (Cursor agent, PR #3, merged via this handover): STRIDE threat model, findings, acceptance checklist in `docs/SECURITY.md`.
2. **Provider research + architecture** (Cursor builder agent, Oct 30): it crashed before pushing code, but its two docs were complete and are salvaged verbatim with an "unverified / design target" banner. Headline conclusions (verify before relying on them):
   - **Primary: Plaid** Transactions + Liabilities + Balance. Request `liabilities` via `required_if_supported_products` (not `products`) so non-supporting Canadian banks still link; use `additional_consented_products: ["liabilities"]` in update mode for existing items.
   - Plaid's Oct 2026 coverage file reportedly flags Liabilities ON for Amex Canada (`ins_100533`), RBC, TD, BMO, CIBC, Scotiabank, National Bank, Tangerine, Canadian Tire; OFF for Desjardins, PC Financial, Simplii, Vancity Visa, EQ, KOHO, Wealthsimple.
   - **Gap-filler if needed: Yodlee** (enterprise contract). **Not** Flinks (no liability fields published), not Finicity/Akoya (no Canada), not Wealthica (investments) or Inverite (lender verification). MX: schema OK, Canadian coverage unverified.
   - Plaid Trial (US/CA signups after Apr 15, 2026) reportedly allows up to 10 real Items incl. Liabilities for free.
3. The builder's half-finished code (encryption at rest, signed sessions, TOTP/passkey, webhook verification, accounts/account_fields tables, overview page) was **not** salvaged. Rebuild it from the docs.

## 4. What is NOT done

- **WP0 (foundation) landed** on branch `wp0-foundation`: lockfile, `next@15.5.28` pinned, Node 22, vitest (`npm test`), CI, DB/client seams.
- **WP4 (revoke, errors, health, sync hardening) landed** on branch `wp4-hardening` (stacks on WP1): revoke-then-delete (`lib/items/revoke.ts`, migration 0005 `status`/`last_error`), `{error:{code}}` bodies via `lib/http/errors.ts`, `/api/health` = `{ok}` + `/api/system`, serialized sync with cursor CAS, `CRON_SECRET` bearer (`authorizeSync` is the hook WP2 extends with the session check), rate limits, LIKE escaping; `lib/http/log-shim.ts` is temporary until WP3's `lib/log.ts`. Closes F-06/07/08/11/13/14/17/19.
- **WP1 (crypto core) landed** on branch `wp1-crypto-core` (stacks on WP0): `lib/crypto.ts` (AES-256-GCM `v1.` ciphertext with AAD, versioned key ring, `constantTimeEqual`/`sha256Hex`/`randomToken`), `npm run key:generate`, boot refuses to start without a 32-byte `TOKEN_ENCRYPTION_KEY`. Tokens are not yet stored encrypted; that is WP3. Still open:
- Any Phase 0 security fix beyond the above. Any liabilities/balance code. Cards overview UI. Reminders. Red-team pass. Test coverage beyond the foundation suites. Multi-user / iOS.

## 5. Security bar (mandatory)

`docs/SECURITY.md` is the acceptance bar; every PR must satisfy its checklist. Critical findings on current `main`:

- `AUTH_MODE` defaults to `none` → anyone reaching the port sees data and can disconnect cards.
- Session cookie is the literal string `ok` (forgeable, unrevocable).
- Plaid access tokens stored plaintext in SQLite and in backups.
- Next.js unpinned, no lockfile → exposed to CVE-2025-29927 middleware bypass; API routes rely on middleware only.
- Disconnect deletes the local token even if Plaid `itemRemove` fails (orphaned, still-billed item).
- Plaintext, non-constant-time password compare; no login rate limit.
- Provider error bodies leak to the client.

## 6. Recommended architecture

Follow `docs/ARCHITECTURE.md` (treat as target design): `CardProvider` adapters → per-field observations (`account_fields`: field, provider, status ∈ present/not_supplied/not_supported/consent_required/error, observed_at) → `mergeCards` on read (present beats missing; then provider priority plaid > yodlee > mx) → overview API → UI. AES-256-GCM column encryption, signed sessions + TOTP/passkey, verified Plaid webhooks (optional; cron default), no manual-entry columns. Urgency computed on America/Toronto dates.

## 7. Phased build plan

- **Phase 0 – Security fixes** (blocker for everything): pin Next.js ≥ patched version + commit lockfile; secure default auth (refuse to start non-localhost with `AUTH_MODE=none`); HMAC-signed expiring sessions; route-level auth checks; constant-time compare + rate limit; encrypt access tokens (+ key outside backups); fix disconnect ordering; sanitize errors; security headers. Add a test runner and tests.
- **Phase 1 – Provider adapter + liabilities**: `CardProvider` interface, Plaid adapter (`/accounts/balance/get` with `/accounts/get` fallback, `/liabilities/get`), migrations for accounts/account_fields, update-mode consent flow, `verify:sandbox` script.
- **Phase 2 – Overview UI + reminders**: cards overview as home (move spending to `/spending`), urgency sort, 7-day highlight, per-currency totals, per-field gap labels; banner + sync summary; later ntfy/email reminders with no account numbers.
- **Phase 3 – Red-team pass**: independent attacker review of the running app against SECURITY.md; fix findings; re-test.
- **Phase 4 (optional) – Multi-user / iOS**: only if the owner chooses App Store publication (see below).

## 8. Open decisions for the owner

1. **App Store or personal-only?** Publishing implies: multi-user accounts and tenant isolation, a hosted backend (Postgres, not local SQLite), an iOS client (Swift or React Native), Apple Developer **organization** account for World's Edge Group (US$99/yr, needs a free D-U-N-S number), aggregator **production** approval, privacy policy/terms/data deletion, **PIPEDA** compliance (plus US state laws if launched there), App Store privacy labels, reviewer demo account, possibly SOC 2 later. Decide before Phase 1 data-model work if possible; retrofitting is expensive.
2. Primary provider: Plaid (recommended) vs another.
3. Pay for a gap-filler (Yodlee) only if a card he actually holds comes back `not_supported`.
4. Hosting: homelab/VPS + Tailscale (recommended for personal) vs public HTTPS (needed for webhooks).
5. Auth mode for personal use: TOTP or passkey.

## 9. Owner-action checklist (Pamimo)

- [ ] Create a Plaid account (dashboard.plaid.com), get `PLAID_CLIENT_ID` + sandbox secret; never paste secrets into chat or commits.
- [ ] Enable Transactions, Liabilities, Balance; leave Auth/Identity/Investments/Transfer off.
- [ ] Apply for Trial or Production access incl. **Liabilities**; check pricing shown in dashboard.
- [ ] Register OAuth redirect URI(s) in the Plaid dashboard (sandbox `http://localhost:3000/plaid/oauth`; production must be exact HTTPS). Note: the salvaged research says Canadian institutions currently don't use OAuth with Plaid, but US issuers do. Verify.
- [ ] Generate and store `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SYNC_TOKEN` in a password manager (once Phase 0 adds them).
- [ ] Decide the open decisions above.
- [ ] If App Store: get D-U-N-S for World's Edge Group, enroll in Apple Developer Program as an organization.

## 10. Run locally / sandbox

```bash
cp .env.example .env.local   # PLAID_CLIENT_ID, PLAID_SECRET (sandbox), PLAID_ENV=sandbox
npm install
npm run dev                  # http://localhost:3000
```

Link with Plaid sandbox creds `user_good` / `pass_good` (MFA `1234` if asked). Click Sync. `npm run sync` triggers sync from cron; `npm run backup` copies the DB. Keep it on localhost while `AUTH_MODE=none`. Full details in `README.md`.

## 11. Suggested first prompt for Claude

> You're taking over the AmexLens repo. Read `HANDOVER.md`, `CLAUDE.md`, `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, and `docs/data-providers.md`. Treat SECURITY.md's checklist as mandatory and the architecture/provider docs as unverified design targets. Start with Phase 0: pin Next.js and add a lockfile, add a test runner, then fix every Critical/High finding in SECURITY.md with tests, in small PRs. Do not add any manual data-entry path. Do not commit secrets. Before Phase 1, re-verify the Plaid Liabilities facts in data-providers.md against Plaid's current docs and tell me which owner actions (keys, product access, redirect URIs) you need from me.

## 12. Other branches

- `claude/swift-analysis-rebuild-6Y7xV`: pre-existing, untouched by this handover; review separately.
- `cursor/security-architecture-9150`: source of `docs/SECURITY.md` (PR #3, superseded by the handover PR).
