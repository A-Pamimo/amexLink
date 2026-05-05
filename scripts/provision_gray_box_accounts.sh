#!/usr/bin/env bash
# Provision an isolated gray-box pentest environment.
# Usage:  ./scripts/provision_gray_box_accounts.sh
# Output: data/graybox/<run_id>/{db.sqlite, .env.graybox, credentials.txt}
#
# All artifacts live under data/graybox/ (gitignored). Tear down with:
#   ./scripts/teardown_gray_box.sh <run_id>

set -euo pipefail

if ! command -v openssl >/dev/null; then
  echo "openssl is required" >&2; exit 1
fi
if ! command -v sqlite3 >/dev/null; then
  echo "sqlite3 is required" >&2; exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 3)"
DIR="data/graybox/${RUN_ID}"
DB="${DIR}/db.sqlite"
ENV_FILE="${DIR}/.env.graybox"
CREDS="${DIR}/credentials.txt"

mkdir -p "${DIR}"
chmod 700 "${DIR}"

APP_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
AUTH_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"

# Pull Plaid sandbox creds from .env.local if they exist; otherwise leave blank.
# We never read or copy production creds.
PLAID_CLIENT_ID=""
PLAID_SECRET=""
if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  set -a; source .env.local; set +a
  if [[ "${PLAID_ENV:-sandbox}" != "sandbox" ]]; then
    echo "Refusing to copy non-sandbox Plaid creds into a graybox env." >&2
    PLAID_CLIENT_ID=""; PLAID_SECRET=""
  fi
fi

cat > "${ENV_FILE}" <<EOF
PLAID_CLIENT_ID=${PLAID_CLIENT_ID}
PLAID_SECRET=${PLAID_SECRET}
PLAID_ENV=sandbox
PLAID_COUNTRY_CODES=US,CA

STORAGE=sqlite
DB_PATH=${DB}

AUTH_MODE=password
AUTH_PASSWORD=${AUTH_PASSWORD}

APP_SECRET=${APP_SECRET}
COOKIE_SECURE=false
EOF
chmod 600 "${ENV_FILE}"

# Apply migrations so schema matches production.
sqlite3 "${DB}" < lib/db/migrations/0001_init.sql

# Seed: one synthetic plaid_item (no real access_token) and ~150 transactions
# per of the 3 test users. We bind transactions to one item_id; the "users"
# are conceptual — the app is single-tenant per host, so for a tester the
# three accounts act as three separate browsers / sessions against the same
# isolated dataset. If your engagement requires multi-tenant separation,
# re-run this script three times for three independent runs.
ITEM_ID="graybox-item-${RUN_ID}"
ACCESS_TOKEN_PLACEHOLDER="graybox-no-real-token-${RUN_ID}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

sqlite3 "${DB}" <<EOF
INSERT INTO plaid_items (id, access_token, item_id, institution_name, institution_id, created_at, last_synced_at, cursor)
VALUES ('graybox-${RUN_ID}', '${ACCESS_TOKEN_PLACEHOLDER}', '${ITEM_ID}', 'GrayBox Bank', 'ins_synthetic', '${NOW}', NULL, NULL);
EOF

# Generate ~450 synthetic transactions spread over the last 6 months.
python3 - "${DB}" "${ITEM_ID}" <<'PY'
import sqlite3, sys, random, datetime, secrets

db_path, item_id = sys.argv[1], sys.argv[2]
random.seed(item_id)  # deterministic per run

BUCKETS = ["food","groceries","travel","transport","utilities","subscriptions",
           "shopping","health","entertainment","education","income","transfers","other"]
MERCHANTS = {
    "food": ["Synthetic Diner","Mock Cafe","Test Burger Co"],
    "groceries": ["Mock Mart","Synthetic Grocer"],
    "travel": ["Mock Airlines","Synthetic Hotel"],
    "transport": ["Mock Rideshare","Test Transit"],
    "utilities": ["Mock Power","Synthetic Telecom"],
    "subscriptions": ["Synthetic Streamer","Mock News"],
    "shopping": ["Mock Marketplace","Synthetic Outfitter"],
    "health": ["Mock Pharmacy","Synthetic Clinic"],
    "entertainment": ["Mock Cinema","Synthetic Arcade"],
    "education": ["Mock University","Synthetic Books"],
    "income": ["Synthetic Payroll"],
    "transfers": ["Mock Card Payment"],
    "other": ["Synthetic Misc"],
}

con = sqlite3.connect(db_path)
cur = con.cursor()
now = datetime.datetime.utcnow().date()
rows = []
for _ in range(450):
    bucket = random.choices(
        BUCKETS,
        weights=[10,8,3,6,4,5,7,3,3,1,1,2,2],
        k=1,
    )[0]
    merchant = random.choice(MERCHANTS[bucket])
    days_ago = random.randint(0, 180)
    date = (now - datetime.timedelta(days=days_ago)).isoformat()
    if bucket == "income":
        amount = -round(random.uniform(800, 3500), 2)
    elif bucket == "transfers":
        amount = round(random.uniform(-2000, 2000), 2)
    else:
        amount = round(random.uniform(2, 220), 2)
    rows.append((
        f"tx_{secrets.token_hex(8)}",
        "acc_graybox_1",
        item_id,
        merchant,
        amount,
        "USD",
        date,
        None, None, merchant, None,
        bucket, 0, 0,
        datetime.datetime.utcnow().isoformat() + "Z",
    ))

cur.executemany("""
  INSERT INTO transactions
    (id, account_id, item_id, name, amount, iso_currency_code, date,
     plaid_category, plaid_category_detailed, merchant_name, logo_url,
     bucket, bucket_override, pending, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
""", rows)
con.commit()
con.close()
PY

# Three test accounts share the dataset (single-tenant app). The "user"
# distinction only matters for session isolation in the tester's browser.
{
  echo "GrayBox engagement run: ${RUN_ID}"
  echo "Provisioned: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "--- App login (AUTH_MODE=password) ---"
  echo "URL:      http://localhost:4000"
  echo "Password: ${AUTH_PASSWORD}"
  echo
  echo "--- Test accounts (browser sessions) ---"
  echo "graybox-1 / graybox-2 / graybox-3"
  echo "(All share the seeded synthetic dataset.)"
  echo
  echo "--- Boot command ---"
  echo "set -a && source ${ENV_FILE} && set +a && PORT=4000 npm run dev"
  echo
  echo "--- Teardown ---"
  echo "./scripts/teardown_gray_box.sh ${RUN_ID}"
} > "${CREDS}"
chmod 600 "${CREDS}"

echo "Provisioned graybox run: ${RUN_ID}"
echo "Creds: ${CREDS}"
echo
echo "Boot:"
echo "  set -a && source ${ENV_FILE} && set +a && PORT=4000 npm run dev"
