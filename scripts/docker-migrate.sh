#!/bin/sh
# Applies the database schema on container startup.
#
# This repo doesn't (yet) have a committed prisma/migrations history — see
# README.md, which documents running `npx prisma migrate dev --name init`
# locally to create one. Until that's committed, `prisma migrate deploy`
# would find nothing to apply and silently no-op, leaving the app pointed
# at a database with no tables. So: fall back to `prisma db push` (syncs
# the schema directly, no migration history needed) when there's nothing
# to deploy, and use the real migration flow automatically once there is.
set -e

if [ -d "prisma/migrations" ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "Found committed migrations — applying with 'prisma migrate deploy'..."
  exec node_modules/.bin/prisma migrate deploy
else
  echo "No committed migrations in prisma/migrations — syncing schema with 'prisma db push' instead."
  echo "Run 'npx prisma migrate dev --name init' locally and commit the result to switch to real migrations."
  exec node_modules/.bin/prisma db push --skip-generate
fi
