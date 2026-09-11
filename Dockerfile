# syntax=docker/dockerfile:1

# ---- Base ----------------------------------------------------------------
# Pin to a specific Node 20 (LTS) Alpine digest-tagged minor, matching the
# engines.node >=20 floor in package.json (nodemailer 10 requires it).
FROM node:20-alpine AS base
WORKDIR /app
# Alpine images don't ship OpenSSL by default; Prisma's query engine needs it.
RUN apk add --no-cache openssl

# ---- Dependencies (full, incl. dev) --------------------------------------
# Cached separately from source so `npm ci` only reruns when the lockfile
# changes, not on every source edit.
FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts: don't let any dependency's install/postinstall hook run
# arbitrary code unreviewed (same rationale as .github/workflows/ci.yml).
# The Prisma client is generated explicitly below instead.
RUN npm ci --ignore-scripts

# ---- Build ----------------------------------------------------------------
FROM deps AS build
COPY prisma ./prisma
RUN npm run prisma:generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- Production dependencies only -----------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY prisma ./prisma
RUN npm run prisma:generate

# ---- Runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY package.json ./

USER app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
