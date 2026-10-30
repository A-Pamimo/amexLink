# CLAUDE.md

Start with `HANDOVER.md` (goals, state, plan, owner actions). Then `docs/SECURITY.md`.

Rules:

- **Never commit secrets** (Plaid keys, access tokens, `.env*` other than `.env.example`, encryption keys, DB files, backups).
- **`docs/SECURITY.md` acceptance checklist is mandatory** for every change. Phase 0 security fixes come before any feature work.
- **No manual data entry or overrides** for card data. All fields come from aggregation APIs; missing fields are shown as missing, with the reason.
- `docs/ARCHITECTURE.md` and `docs/data-providers.md` are salvaged, **unverified** drafts: verify vendor facts before relying on them; code they mention does not exist yet.
- Never log or return access tokens, provider error bodies, or full account numbers.
- Dates/urgency use America/Toronto. Totals are per currency.
- Small PRs with tests; don't touch the `claude/swift-analysis-rebuild-6Y7xV` branch unless asked.
