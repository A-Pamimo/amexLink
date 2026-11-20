#!/bin/sh
# Container entrypoint (Dockerfile). Starts as root only to fix ownership of the
# Fly volume (mounted root-owned), then drops to uid/gid 1001 (amex) and execs
# the server. Binds 0.0.0.0 because the Fly proxy reaches the VM over its private
# network; this is the documented deviation from SECURITY.md 3.9 (docs/deploy/fly.md).
set -eu

DATA_DIR=/data

if [ -d "$DATA_DIR" ] && [ "$(stat -c %u "$DATA_DIR")" = "0" ]; then
  chown -R amex:amex "$DATA_DIR"
fi

# Nothing here needs a home directory; keep tools from probing /root.
export HOME=/tmp

# With arguments (the scheduled sync machine: `node scripts/sync.mjs --allow-remote`), run them
# as the app user instead of the server.
if [ "$#" -gt 0 ]; then
  exec setpriv --reuid=1001 --regid=1001 --init-groups "$@"
fi

exec setpriv --reuid=1001 --regid=1001 --init-groups \
  node node_modules/next/dist/bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
