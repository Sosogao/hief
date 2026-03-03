FROM node:20-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/agent/package.json ./packages/agent/

RUN pnpm install --frozen-lockfile

COPY packages/common ./packages/common
COPY packages/agent ./packages/agent

RUN pnpm --filter @hief/common build
RUN pnpm --filter @hief/agent build

FROM node:20-alpine AS runtime

RUN npm install -g pnpm && apk add --no-cache wget

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/common/package.json ./packages/common/
COPY packages/agent/package.json ./packages/agent/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/agent/dist ./packages/agent/dist

EXPOSE 3000

CMD ["node", "packages/agent/dist/server.js"]
