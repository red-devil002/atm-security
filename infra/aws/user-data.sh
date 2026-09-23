#!/bin/bash
# infra/aws/user-data.sh — Launch template User Data (Ubuntu or Amazon Linux 2023)
#
# BEFORE PASTING INTO THE LAUNCH TEMPLATE: replace the placeholder below
# with the real Atlas connection string. NEVER commit the real value.
# Log on the instance: /var/log/atm-userdata.log
set -euo pipefail
exec > >(tee -a /var/log/atm-userdata.log) 2>&1
echo "=== ATM user data start $(date -u) ==="

MONGO_URI='__PASTE_MONGO_URI_HERE__'

# --- Fail-fast guard: refuse to boot with a placeholder or empty secret ---
if [[ -z "$MONGO_URI" || "$MONGO_URI" == *__PASTE* || "$MONGO_URI" == *"<password>"* ]]; then
  echo "FATAL: MONGO_URI is still a placeholder. Fix the launch template User Data." >&2
  exit 1
fi

# --- Packages: Docker, git, curl, Node 22 (works on Ubuntu or Amazon Linux 2023) ---
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y docker.io git curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  dnf install -y docker git
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
fi
node -v
systemctl enable --now docker

# --- Postgres (local container, same as Week 6) ---
docker run -d --name atm-postgres --restart unless-stopped \
  -e POSTGRES_PASSWORD=devpassword -p 5432:5432 postgres:16
until docker exec atm-postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done
sleep 3
docker exec -i atm-postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS atms (atm_id TEXT PRIMARY KEY, location TEXT, city_zone TEXT);
CREATE TABLE IF NOT EXISTS maintenance_schedule (
  schedule_id SERIAL PRIMARY KEY, atm_id TEXT REFERENCES atms(atm_id),
  start_time TIMESTAMP, end_time TIMESTAMP, technician TEXT);
CREATE TABLE IF NOT EXISTS staff (staff_id SERIAL PRIMARY KEY, name TEXT, role TEXT);
INSERT INTO atms (atm_id, location, city_zone)
  SELECT 'atm-' || lpad(i::text, 3, '0'), 'Site ' || i, 'zone-' || ((i % 3) + 1)
  FROM generate_series(1, 10) i
ON CONFLICT DO NOTHING;
INSERT INTO maintenance_schedule (atm_id, start_time, end_time, technician)
  VALUES ('atm-003', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '30 days', 'Test Tech');
SQL

# --- App ---
git clone --depth 1 https://github.com/red-devil002/atm-security.git /opt/atm-security
cd /opt/atm-security
npm ci --omit=dev
# No spaces, no quotes (dotenv format rule from Week 7 rebuild)
printf 'MONGO_URI=%s\nPG_PORT=5432\n' "$MONGO_URI" > analysis-service/.env
chmod 600 analysis-service/.env

# WorkingDirectory matters: dotenv reads .env from the current directory.
cat > /etc/systemd/system/atm-analysis.service <<'UNIT'
[Unit]
Description=ATM analysis service
After=network-online.target docker.service
Wants=network-online.target

[Service]
WorkingDirectory=/opt/atm-security/analysis-service
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now atm-analysis

# --- Self-test: a REAL transaction, not just /health ---
for i in $(seq 1 20); do
  code=$(curl -s -o /tmp/tx.json -w '%{http_code}' -X POST http://localhost:3000/transaction \
    -H 'Content-Type: application/json' \
    -d '{"atmId":"atm-001","type":"withdrawal","amount":100,"timestamp":"2026-01-01T00:00:00Z"}' || true)
  [[ "$code" == "200" ]] && break
  sleep 3
done
if [[ "$code" != "200" ]]; then
  echo "FATAL: POST /transaction returned $code — stopping service so the ALB marks this target unhealthy." >&2
  journalctl -u atm-analysis --no-pager | tail -30
  systemctl stop atm-analysis
  exit 1
fi
echo "SELF-TEST OK: POST /transaction -> 200 $(cat /tmp/tx.json)"
echo "=== ATM user data done $(date -u) ==="
