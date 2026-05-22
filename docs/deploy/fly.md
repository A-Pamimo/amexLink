# Deploy to Fly.io

End-to-end, phone-friendly. Two paths: CLI (faster) or web UI (no terminal needed). Use whichever you have access to.

## Prereqs

- A Fly account (https://fly.io). Free tier is fine.
- Your Plaid sandbox credentials (`PLAID_CLIENT_ID`, `PLAID_SECRET`).

## Path A — CLI (Termux on Android, or any laptop/Codespace)

```bash
# 1. Install flyctl
curl -L https://fly.io/install.sh | sh

# 2. Login (opens a browser tab)
flyctl auth login

# 3. Pick a unique app name and region. fly.toml defaults to "amexlens" + "iad".
#    Edit fly.toml if you want a different region (lhr / fra / sjc / syd / etc.).
flyctl apps create amexlens-<your-suffix>

# 4. Create the persistent volume (1GB is plenty for personal use)
flyctl volumes create amexlens_data --region iad --size 1 --app amexlens-<your-suffix>

# 5. Set secrets (these never appear in fly.toml, GitHub, or logs)
flyctl secrets set \
  APP_SECRET="$(openssl rand -base64 48)" \
  AUTH_PASSWORD="$(openssl rand -base64 24)" \
  PLAID_CLIENT_ID="<your-plaid-client-id>" \
  PLAID_SECRET="<your-plaid-secret>" \
  --app amexlens-<your-suffix>

# 6. Deploy
flyctl deploy --app amexlens-<your-suffix>

# 7. Open it
flyctl open --app amexlens-<your-suffix>
```

Save the `AUTH_PASSWORD` from step 5 — you'll need it to log in.

## Path B — Web UI (truly phone-friendly)

1. Push this repo to GitHub (you already have the branch).
2. Visit https://fly.io/launch/from-github and connect the `amexlink` repo.
3. Fly detects `fly.toml` and the `Dockerfile`. Confirm region + machine size.
4. Before clicking **Deploy**, set these secrets in the UI:
   - `APP_SECRET` — paste the output of `openssl rand -base64 48` (use any phone password generator if you can't run openssl)
   - `AUTH_PASSWORD` — your login password
   - `PLAID_CLIENT_ID`
   - `PLAID_SECRET`
5. Create a 1GB volume named `amexlens_data` in the same region (Volumes tab → Create).
6. Click Deploy.

## Verify

```bash
# From phone or laptop
curl -I https://<your-app>.fly.dev/
# Expect: HTTP/2 307 (redirect to /login because AUTH_MODE=password)
#         strict-transport-security: max-age=...
#         x-frame-options: DENY
#         content-security-policy: ...

curl -s https://<your-app>.fly.dev/api/health
# Expect: {"ok":true} or similar
```

Then open `https://<your-app>.fly.dev/` in a browser, log in with the `AUTH_PASSWORD` you set, and link a Plaid sandbox card.

## Things to know

- **Single machine, single region.** Sqlite is single-writer; never scale this past one machine while using sqlite. If you ever need HA, switch `STORAGE` to `libsql` + Turso first.
- **Cold starts.** `min_machines_running = 0` means the app sleeps when idle and takes ~3–5s to wake. To eliminate that, set it to `1` (uses your free-tier resources continuously).
- **Backups.** Fly volumes get nightly snapshots automatically (retained 5 days on the free tier). For longer retention, run `litestream` to S3 — see `docs/deploy/backups.md` (TODO).
- **Custom domain.** `flyctl certs add yourdomain.com` then point a CNAME to `<app>.fly.dev`. Fly handles Let's Encrypt automatically. After it's live, set `CSRF_ALLOWED_ORIGINS=https://yourdomain.com` via `flyctl secrets set`.
- **Rotating `APP_SECRET`** invalidates every linked Plaid card and every active session. Don't do it casually.

## Rollback

```bash
flyctl releases --app amexlens-<your-suffix>      # list
flyctl releases rollback <version> --app amexlens-<your-suffix>
```

## Tear down

```bash
flyctl apps destroy amexlens-<your-suffix>
flyctl volumes destroy <volume-id>
```
