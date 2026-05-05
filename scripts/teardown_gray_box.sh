#!/usr/bin/env bash
# Wipe a graybox engagement run. Usage: ./scripts/teardown_gray_box.sh <run_id>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <run_id>" >&2; exit 1
fi
RUN_ID="$1"
DIR="data/graybox/${RUN_ID}"

if [[ ! -d "${DIR}" ]]; then
  echo "no such run: ${DIR}" >&2; exit 1
fi

# Belt-and-braces: never let this resolve to anything outside data/graybox.
case "${DIR}" in
  data/graybox/*) ;;
  *) echo "refusing to delete ${DIR}" >&2; exit 1;;
esac

rm -rf "${DIR}"
echo "torn down: ${RUN_ID}"
