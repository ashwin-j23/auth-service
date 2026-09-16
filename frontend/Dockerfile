# syntax=docker/dockerfile:1

# Build-only image: produces a static dist/ that docker-compose.yml's
# frontend-build service copies out to a volume nginx serves directly.
# There's no runtime stage — this app has no server of its own in production.
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts: same rationale as the backend Dockerfile/CI — don't let
# a dependency's install hook run arbitrary code unreviewed.
RUN npm ci --ignore-scripts

FROM deps AS build
COPY . .
RUN npm run build
