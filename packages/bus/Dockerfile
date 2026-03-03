# ── Stage 1: Builder ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/bus/package.json ./packages/bus/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/common ./packages/common
COPY packages/bus ./packages/bus

# Build common first, then bus
RUN pnpm --filter @hief/common build
RUN pnpm --filter @hief/bus build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN npm install -g pnpm && apk add --no-cache wget

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/common/package.json ./packages/common/
COPY packages/bus/package.json ./packages/bus/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/bus/dist ./packages/bus/dist

EXPOSE 3001

CMD ["node", "packages/bus/dist/server.js"]
