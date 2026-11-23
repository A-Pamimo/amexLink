#!/usr/bin/env bash
# Create the daily sync machine for AmexLens on Fly.io (docs/deploy/fly.md).
#
#   scripts/fly/schedule-sync.sh            use the app's current deployed image
#   IMAGE=registry.fly.io/... scripts/fly/schedule-sync.sh
#   scripts/fly/schedule-sync.sh --help
#
# Env: FLY_APP (default amexlens-wedge), IMAGE (optional override).
# The machine belongs to the same app, so it inherits the app's secrets
# (CRON_SECRET). It runs `node scripts/sync.mjs --allow-remote` against the
# public https origin once a day, which also wakes the auto-stopped app machine.
# Idempotent: skipped when a machine named amexlens-sync exists. After a deploy
# the scheduled machine keeps its old image; destroy it and re-run this script
# to move it to the new image (only scripts/sync.mjs runs there).
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

APP="${FLY_APP:-amexlens-wedge}"
NAME="amexlens-sync"

command -v flyctl >/dev/null || { echo "schedule-sync: flyctl not found" >&2; exit 1; }

if flyctl machine list --app "$APP" 2>/dev/null | awk -v v="$NAME" '{for (i = 1; i <= NF; i++) if ($i == v) f = 1} END {exit !f}'; then
  echo "machine $NAME already exists, skipping"
  exit 0
fi

if [[ -z "${IMAGE:-}" ]]; then
  # `flyctl image show` prints Registry / Repository / Tag columns; build registry/repo:tag from them.
  IMAGE="$(flyctl image show --app "$APP" --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s); const i = Array.isArray(j) ? j[0] : j;
        const ref = i.Registry && i.Repository && i.Tag ? `${i.Registry}/${i.Repository}:${i.Tag}` : "";
        process.stdout.write(ref);
      } catch { process.stdout.write(""); }
    });')"
fi
if [[ -z "$IMAGE" ]]; then
  echo "schedule-sync: could not determine the current image. Deploy first, or pass IMAGE=registry.fly.io/<app>:<tag>" >&2
  exit 1
fi

flyctl machine run "$IMAGE" \
  --app "$APP" \
  --region yyz \
  --schedule daily \
  --vm-memory 256 \
  --name "$NAME" \
  -e "BASE_URL=https://$APP.fly.dev" \
  --command "node scripts/sync.mjs --allow-remote"

echo "created $NAME (daily). Check with: flyctl logs --app $APP"
