#!/usr/bin/env bash
# One-time, idempotent Fly.io provisioning for AmexLens (docs/deploy/fly.md).
#
#   scripts/fly/provision.sh            create app, volume, generated secrets
#   scripts/fly/provision.sh --help
#
# Env: FLY_APP (default amexlens-wedge). Region is yyz (Toronto).
# Requires: flyctl (logged in), node, openssl. Run from the repository root.
#
# Generated secrets (TOKEN_ENCRYPTION_KEY, CRON_SECRET) are piped straight into
# `flyctl secrets set --stage` and are never printed. Re-running does not rotate
# them: it skips secret generation when the app already has TOKEN_ENCRYPTION_KEY,
# because replacing the data key would make every stored token unreadable.
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

APP="${FLY_APP:-amexlens-wedge}"
REGION="yyz"
VOLUME="amexlens_data"

command -v flyctl >/dev/null || { echo "provision: flyctl not found (https://fly.io/docs/flyctl/install/)" >&2; exit 1; }
command -v node >/dev/null || { echo "provision: node not found" >&2; exit 1; }
command -v openssl >/dev/null || { echo "provision: openssl not found" >&2; exit 1; }
[[ -f scripts/key-generate.mjs ]] || { echo "provision: run from the repository root" >&2; exit 1; }

echo "== App $APP"
if flyctl apps list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$APP"; then
  echo "app exists, skipping"
else
  flyctl apps create "$APP" --org personal
fi

echo "== Volume $VOLUME ($REGION, 1 GB)"
if flyctl volumes list --app "$APP" 2>/dev/null | awk -v v="$VOLUME" '{for (i = 1; i <= NF; i++) if ($i == v) f = 1} END {exit !f}'; then
  echo "volume exists, skipping"
else
  flyctl volumes create "$VOLUME" --app "$APP" --region "$REGION" --size 1 --yes
fi

echo "== Generated secrets (staged, never printed)"
if flyctl secrets list --app "$APP" 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "TOKEN_ENCRYPTION_KEY"; then
  echo "TOKEN_ENCRYPTION_KEY already set, not rotating (a new key would orphan every stored token)"
else
  TOKEN_ENCRYPTION_KEY="$(node scripts/key-generate.mjs 2>/dev/null | cut -d= -f2-)"
  CRON_SECRET="$(openssl rand -base64 32)"
  flyctl secrets set --app "$APP" --stage \
    "TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}" \
    "CRON_SECRET=${CRON_SECRET}" >/dev/null
  unset TOKEN_ENCRYPTION_KEY CRON_SECRET
  echo "staged TOKEN_ENCRYPTION_KEY and CRON_SECRET (applied on the next deploy)"
fi

cat <<EOF

== Next steps (owner)
1. Add these secrets yourself, in the Fly dashboard (https://fly.io/apps/$APP/secrets)
   or with: flyctl secrets set --app $APP --stage NAME=value
     PLAID_CLIENT_ID       from the Plaid dashboard
     PLAID_SECRET          the sandbox secret
     AUTH_SETUP_TOKEN      at least 32 random characters (openssl rand -base64 32)
     BACKUP_AGE_RECIPIENT  optional, an age public key (age1...)
   Never paste these into chat, commits or CI logs.
2. Register this redirect URI in the Plaid dashboard (Developers > API > Allowed redirect URIs):
     https://$APP.fly.dev/plaid/oauth
3. Deploy:
     flyctl deploy --remote-only --ha=false
EOF
