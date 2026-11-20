# Deploying AmexLens on Fly.io (Toronto, `yyz`)

Reference deployment: one Fly machine, one 1 GB volume, SQLite, Plaid sandbox first. The repository files are `Dockerfile`, `scripts/docker-entrypoint.sh`, `fly.toml`, `.github/workflows/fly-deploy.yml` and `scripts/fly/`. The Docker image has not been built in CI; the first `fly deploy` is its build proof, so treat the first deploy as a test.

Public origin: `https://amexlens-wedge.fly.dev`. The name is globally unique on Fly; see [Renaming](#renaming-the-app).

## 1. Prerequisites

- A Fly.io account with a payment method, and `flyctl` installed and logged in (`flyctl auth login`).
- `node` (22) and `openssl` on the machine that runs the provisioning script. `npm ci` is not needed.
- A Plaid account with the sandbox `PLAID_CLIENT_ID` and secret (README "Environment variables"). Never paste them into chat, commits or CI logs.
- Optional: an age keypair for backups (`age-keygen -o amexlens-backup.key`). The identity stays off Fly.

## 2. One-time provisioning

From the repository root:

```bash
scripts/fly/provision.sh
```

It is idempotent. It creates the app (`--org personal`), a 1 GB volume `amexlens_data` in `yyz`, and stages two generated secrets, `TOKEN_ENCRYPTION_KEY` and `CRON_SECRET`, without printing them. Re-running it never rotates an existing `TOKEN_ENCRYPTION_KEY`, because a new key would make every stored token unreadable.

Then set the owner-only secrets (next section) and deploy:

```bash
flyctl deploy --remote-only --ha=false
```

`--ha=false` keeps a single machine. Never run more than one: SQLite is a single-writer file on one volume, and lockout and rate-limit counters are in process memory.

## 3. Secrets

Secrets live in Fly, never in `fly.toml`, the repository or CI. Non-secret settings are in the `[env]` block of `fly.toml`.

| Secret | Set by | Why |
| --- | --- | --- |
| `TOKEN_ENCRYPTION_KEY` | `provision.sh` (generated on the machine running it) | AES-256-GCM data key for Plaid access tokens and the TOTP secret. Boot refuses to start without a valid 32-byte key. |
| `CRON_SECRET` | `provision.sh` | Bearer for `POST /api/plaid/sync` from the scheduled sync machine (at least 32 chars). |
| `PLAID_CLIENT_ID` | Owner, Fly dashboard or `flyctl secrets set` | Issued to the owner's Plaid account. Claude and CI have no reason to hold it. |
| `PLAID_SECRET` | Owner | The sandbox secret now, a different production secret later. The code cannot tell which one it was given (SECURITY.md 3.1). |
| `AUTH_SETUP_TOKEN` | Owner (at least 32 random characters, `openssl rand -base64 32`) | Authorises first-run enrolment on `/login`. Whoever holds it while no factor is enrolled can become the owner, so only the owner should ever see it. Remove or rotate it after setup. |
| `BACKUP_AGE_RECIPIENT` | Owner, optional | age **public** key `age1...` that `scripts/backup.mjs` encrypts to. Without it the backup script refuses to run. |

`AUTH_SETUP_TOKEN` and the Plaid keys are owner-set only so that no automation, log or chat transcript ever contains them. Set them in the dashboard (`https://fly.io/apps/amexlens-wedge/secrets`) or with `flyctl secrets set --app amexlens-wedge --stage NAME=value` followed by a deploy. Staged secrets apply on the next deploy.

Register the OAuth redirect URI in the Plaid dashboard (Developers > API > Allowed redirect URIs): `https://amexlens-wedge.fly.dev/plaid/oauth`. Boot refuses a `PLAID_REDIRECT_URI` that is not on `APP_ORIGIN`.

### If the app will not start

Boot refuses to run without a valid `TOKEN_ENCRYPTION_KEY` (or with any other invalid config), logs `boot_refused` and exits 1. Fly restarts the machine a few times and then leaves it stopped. Read `fly logs` for the reason, fix the secret, and redeploy.

## 4. First-run setup

1. Open `https://amexlens-wedge.fly.dev/login`.
2. Paste `AUTH_SETUP_TOKEN`, scan the TOTP QR code, save the 10 recovery codes in a password manager.
3. Add a passkey. The `fly.dev` hostname is a valid WebAuthn RP ID.
4. Remove or rotate `AUTH_SETUP_TOKEN`.
5. Link a sandbox card (`user_good` / `pass_good`) from Settings and confirm Plaid Link renders under the nonce CSP. If a card reports `consent_required`, use Settings, "Grant liabilities access".

## 5. Daily sync machine

```bash
scripts/fly/schedule-sync.sh
```

Creates a Fly scheduled machine `amexlens-sync` (daily, 256 MB, `yyz`) from the app's current image. It runs `node scripts/sync.mjs --allow-remote` with `BASE_URL=https://amexlens-wedge.fly.dev`, inherits `CRON_SECRET` as an app secret, and posts to the public URL, which also wakes the auto-stopped app machine. The script skips creation if the machine exists. A scheduled machine keeps the image it was created with; after a deploy that changes `scripts/sync.mjs`, destroy it (`flyctl machine destroy <id> --force`) and re-run the script.

## 6. Backups

- **Volume snapshots.** Fly takes daily snapshots of the volume and keeps them 5 days by default. They are encrypted at rest by Fly, but the SQLite file inside holds plaintext transaction and liability rows (only tokens and the TOTP secret are column-encrypted). The data key is a secret, not on the volume.
- **Encrypted application backups.** With `BACKUP_AGE_RECIPIENT` set:
  ```bash
  fly ssh console -C "node scripts/backup.mjs"
  fly ssh console -C "ls /data/backups"
  fly ssh sftp get /data/backups/amexlens-<stamp>.sqlite.age
  ```
  Keep the newest 7 on the volume (`BACKUP_KEEP`). Automated off-box upload is a follow-up. Run the restore drill (README "Backups and restore drill") once with the identity on your own machine.
- **Key retrieval, once.** Copy the data key into a password manager right after the first deploy, then do not leave it in a shell history or terminal log:
  ```bash
  fly ssh console -C 'printenv TOKEN_ENCRYPTION_KEY'
  ```
  Losing it means re-linking every card. A backup plus the key is every token, so store them in different places.
- Check no plaintext tokens remain on the volume: `fly ssh console -C "node scripts/verify-no-plaintext.mjs /data"` (exit 0), and `stat -c %a /data/amexlens.sqlite` shows `600`.

## 7. Logs

`fly logs --app amexlens-wedge`. The app writes JSON lines that are already redacted (no tokens, provider error bodies or account numbers). Look for `boot_refused`, `sync_finished`, `token_decrypt_failed`.

## 8. Deploys, rollback and Plaid Trial or production

- **Automatic deploys.** `.github/workflows/fly-deploy.yml` runs after the `ci` workflow succeeds on `main`, and on manual dispatch. It needs a repository secret `FLY_API_TOKEN` holding a Fly deploy token scoped to this app (`flyctl tokens create deploy --app amexlens-wedge`). Without the secret the job skips. Two deploys never run at once.
- **Rollback.** `fly releases --app amexlens-wedge` lists releases and images; redeploy a previous image with `fly deploy --image <image-ref> --ha=false`. Schema migrations only move forward, so restore a backup if a release changed the schema.
- **Plaid Trial or production.** Change `PLAID_ENV` in `fly.toml`, replace `PLAID_SECRET` (and `PLAID_CLIENT_ID` if it differs), register the https redirect URI in the production dashboard, and redeploy. The production server refuses an `http://` origin or redirect URI. Trial Item caps are lifetime, so do not burn Items re-linking.
- **Resizing.** If the first deploy is killed for memory, set `memory = "1gb"` in `fly.toml`.

## 9. Renaming the app

The name must be globally unique. Change it in three places in `fly.toml`: `app`, `APP_ORIGIN` and `PLAID_REDIRECT_URI`. Register the new redirect URI in Plaid, and pass `FLY_APP=<name>` to `scripts/fly/*.sh`. Passkeys and sessions are bound to the origin, so enrol again after a rename.

## 10. Teardown

```bash
flyctl apps destroy amexlens-wedge     # also deletes the volume and its snapshots
```

Disconnect the cards in Settings first so Plaid revokes the tokens, and download any backups you want to keep.

## 11. Deviations from SECURITY.md 3.9

| 3.9 default | On Fly | Why it is acceptable |
| --- | --- | --- |
| `next start` bound to `127.0.0.1`, reverse proxy on the same host | The entrypoint runs `next start -H 0.0.0.0 -p 3000` | Fly's proxy terminates TLS and reaches the VM over its private network. Only the proxy and the app's private 6PN network can reach the VM; the machine has no other public listener. The `npm start` script and local runs stay on loopback. |
| App tree not writable by the app user | Image tree is root-owned; the app user writes only `/data` and `.next/cache` | Matches the default. |
| Dedicated unprivileged user | The container starts as root only to `chown /data` (Fly volumes mount root-owned), then drops to uid 1001 with `setpriv` under `tini` | Server and sync run unprivileged. |
| systemd hardening | Container isolation (Firecracker microVM) | `umask 077`, `0700`/`0600` modes are still enforced by the app. |
| Full-disk encryption | Fly volumes are encrypted at rest | A snapshot holds plaintext transaction rows (see SECURITY.md section 8). |
| Sync over loopback | The sync bearer is sent over TLS to the public Fly edge | That edge route is the only one that wakes an auto-stopped machine. The secret is dedicated, at least 32 characters and rotatable. |
| Per-IP throttle on `/api/auth/login/*` at the proxy | Not configured | Residual risk 2 in SECURITY.md section 8 applies (one global lockout counter). |
