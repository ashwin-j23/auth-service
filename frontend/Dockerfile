# syntax=docker/dockerfile:1

# Build-only image: produces a static dist/ that docker-compose.yml's
# frontend-build service copies out to a volume nginx serves directly.
# There's no runtime stage — this app has no server of its own in production.
FROM node:20-alpine AS base
WORKDIR /app
# Non-root, matching the backend Dockerfile's runtime stage. /out is
# docker-compose.yml's frontend-build service's volume mount target (see
# its `cp -r dist/. /out/` command) — created and chowned here, as root,
# so that a first-time volume mount inherits app:app ownership instead of
# defaulting to root and rejecting that non-root `cp`.
RUN addgroup -S app && adduser -S app -G app && mkdir -p /out && chown app:app /out
USER app

FROM base AS deps
COPY --chown=app:app package.json package-lock.json ./
# --ignore-scripts: same rationale as the backend Dockerfile/CI — don't let
# a dependency's install hook run arbitrary code unreviewed.
RUN npm ci --ignore-scripts

FROM deps AS build
# Explicit file list instead of `COPY . .`, so nothing outside what the
# build actually needs (env files, git metadata, etc.) can end up in the
# image even if .dockerignore is ever out of date.
COPY --chown=app:app index.html postcss.config.js tailwind.config.ts tsconfig.json vite.config.ts ./
COPY --chown=app:app src ./src
RUN npm run build
