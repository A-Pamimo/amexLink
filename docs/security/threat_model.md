# Threat Model — AmexLens

> Methodology: STRIDE, lightweight. One pass; revisit after material changes.

## System under analysis

A self-hosted Next.js 14 app that:
- Authenticates a single user (optional password) and renders a personal-finance dashboard.
- Stores Plaid `item` records (with `access_token`) and transactions in local SQLite.
- Calls Plaid's REST API to sync transactions.
- Runs as a containerized Node process behind a Caddy reverse proxy with TLS.

Deploy targets in scope: **AWS / GCP / fly.io / Hetzner / homelab**. Vercel is out (better-sqlite3 native module). Multi-tenant deploys are out.

## Trust boundaries

```
[ Browser ] --HTTPS--> [ Caddy (TLS, headers) ] --HTTP/loopback--> [ Next.js Node ]
                                                                       |
                                                                       +-- [ SQLite file (encrypted volume) ]
                                                                       +-- [ Plaid REST (TLS, secret in env) ]
```

## Assets

| # | Asset | Sensitivity |
|---|---|---|
| A1 | Plaid `access_token` per linked card | **High** — replayable card access until rotated |
| A2 | `APP_SECRET` (HMAC + at-rest key) | **Critical** — leaks all of A1 + session forgery |
| A3 | `PLAID_SECRET` | **High** — Plaid client identity |
| A4 | Transaction history | **Medium** — financial PII |
| A5 | Session cookie | **Medium** — temporary auth |
| A6 | `AUTH_PASSWORD` | **Medium** — single shared password |

## STRIDE

### Spoofing
- **T-S1**: Attacker forges a session cookie. *Mitigated:* HMAC-signed cookie verified in middleware via Web Crypto; rejects on signature/age mismatch.
- **T-S2**: Attacker forges Plaid webhooks. *Status:* webhooks not implemented yet. When added, require Plaid's signed `JWT` verification.

### Tampering
- **T-T1**: Tamper with `bucket` of a transaction. *Mitigated:* PATCH route validates against `ALL_BUCKETS` allowlist; stored as `bucket_override=1` so re-syncs don't blow it away.
- **T-T2**: Tamper with on-disk SQLite when host is compromised. *Partially mitigated:* `access_token` is encrypted at rest with `APP_SECRET`. Other fields are not — accept the risk for v1.

### Repudiation
- **T-R1**: User claims they didn't override a bucket. *Status:* no audit log. Acceptable for personal-use scope; add `audit_log` table if multi-tenant.

### Information disclosure
- **T-I1**: `/api/items` leaks `access_token`. *Mitigated:* response strips `access_token` before returning.
- **T-I2**: SSRF via misuse of the Plaid client. *Mitigated:* only `lib/plaid.ts` constructs Plaid clients; `basePath` is from a fixed enum; user input never reaches the URL.
- **T-I3**: Error messages leak Plaid request IDs / stack traces. *Partially mitigated:* errors return `err?.response?.data ?? err?.message`. Acceptable for sandbox; in prod, sanitize to `"sync failed"` and log the detail server-side.
- **T-I4**: Side-channel timing on password compare. *Mitigated:* `crypto.timingSafeEqual` via `constantTimeEqual()`.
- **T-I5**: Session cookie sniffed on plaintext HTTP. *Mitigated:* `secure: true` flag set automatically when request is HTTPS; Caddy enforces TLS.

### Denial of service
- **T-D1**: Brute-force login. *Mitigated:* `5 attempts / 10 min / IP` rate limit on `/api/auth/login`.
- **T-D2**: Plaid sync hammering. *Mitigated:* `30 req/min/IP` on `/api/plaid/sync`.
- **T-D3**: Volumetric DoS at network layer. *Out of scope:* host with provider-level DDoS protection (CloudFront / Cloud Armor / fly proxy / Cloudflare in front).

### Elevation of privilege
- **T-E1**: CSRF from a malicious page elevates an attacker's request to the user's session. *Mitigated:* `assertSameOrigin()` rejects state-changing requests whose `Origin`/`Referer` don't match the host. Cookie is `sameSite=lax` as a second line.
- **T-E2**: XSS via merchant name rendered as HTML. *Mitigated:* React escapes by default; no `dangerouslySetInnerHTML` anywhere; CSP forbids inline `<object>` and limits scripts to `'self'` + Plaid CDN.
- **T-E3**: Path traversal via filenames. *N/A:* no user-supplied paths reach the filesystem.

## Residual risks accepted

- Single-process, single-host. No HA, no clustering. Acceptable for personal use.
- In-memory rate limiter; resets on restart.
- No audit log; bucket-override history isn't recoverable.
- `APP_SECRET` rotation invalidates every linked card and every active session — no key-versioning yet. Document, accept.
- Same-site=lax + origin check, not a per-request CSRF token. Sufficient given the session is HTTP-only and the app's only state-changing endpoints are JSON POST/PATCH/DELETE from same-origin React.
- No Subresource Integrity on the Plaid CDN script (Plaid doesn't publish stable SRI hashes). Accept.

## Re-evaluation triggers

Revisit this document if any of:
- Multi-user / multi-tenant added
- Webhooks enabled
- Storage swapped to libsql/postgres
- Mobile / native client added
- Public deployment beyond a single trusted user
