#!/bin/sh
# Applies the database schema on container startup.
#
# prisma/migrations/ is committed (see 20260916141053_init), so the normal
# path below is 'prisma migrate deploy'. The 'prisma db push' fallback
# stays in place for anyone who deletes/regenerates that history locally
# without recommitting it — deploy would otherwise find nothing to apply
# and silently no-op, leaving the app pointed at a database with no tables.
set -e

if [ -d "prisma/migrations" ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "Found committed migrations — applying with 'prisma migrate deploy'..."
  exec node_modules/.bin/prisma migrate deploy
else
  echo "No committed migrations in prisma/migrations — syncing schema with 'prisma db push' instead."
  echo "Run 'npx prisma migrate dev --name init' locally and commit the result to switch to real migrations."
  exec node_modules/.bin/prisma db push --skip-generate
fi
