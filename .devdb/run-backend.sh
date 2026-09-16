#!/usr/bin/env bash
# Local, throwaway dev-stack runner: starts a user-owned Postgres cluster
# under .devdb/, applies Prisma migrations, then runs the backend and
# frontend dev servers. Not part of the app's real deploy path — see
# docker-compose.yml / README.md for that.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[run-backend] starting postgres..."
postgres -D .devdb/data -p 5432 -c unix_socket_directories='' >> .devdb/logfile 2>&1 &

echo "[run-backend] waiting for postgres to accept connections..."
for i in $(seq 1 30); do
  if psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "select 1" >/dev/null 2>&1; then
    echo "[run-backend] postgres is ready"
    break
  fi
  sleep 1
done

echo "[run-backend] ensuring auth_service database exists..."
if ! psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='auth_service'" | grep -q 1; then
  psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "CREATE DATABASE auth_service OWNER postgres;"
fi

echo "[run-backend] applying prisma schema..."
if [ -z "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  npx prisma migrate dev --name init --skip-generate
else
  npx prisma migrate deploy
fi

echo "[run-backend] starting auth-service (tsx watch)..."
npm run dev &

echo "[run-backend] starting frontend (vite)..."
cd frontend
exec npm run dev -- --port 3000 --strictPort
