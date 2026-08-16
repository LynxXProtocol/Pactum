#!/bin/sh
# Runs the TimescaleDB migrations before handing control to the API process.
# Postgres is already healthy by the time compose starts us, but the retry loop
# keeps startup deterministic when the container is run outside compose.
set -e

MAX_ATTEMPTS="${MIGRATE_MAX_ATTEMPTS:-10}"
RETRY_DELAY="${MIGRATE_RETRY_DELAY_SECONDS:-3}"
attempt=1

while true; do
  echo "[entrypoint] running migrations (attempt ${attempt}/${MAX_ATTEMPTS})"
  if node dist/db/migrate.js; then
    echo "[entrypoint] migrations complete"
    break
  fi

  if [ "${attempt}" -ge "${MAX_ATTEMPTS}" ]; then
    echo "[entrypoint] migrations failed after ${attempt} attempts" >&2
    exit 1
  fi

  attempt=$((attempt + 1))
  sleep "${RETRY_DELAY}"
done

exec "$@"
