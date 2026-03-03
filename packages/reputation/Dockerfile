FROM node:20-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/reputation/package.json ./packages/reputation/

RUN pnpm install --frozen-lockfile

COPY packages/common ./packages/common
COPY packages/reputation ./packages/reputation

RUN pnpm --filter @hief/common build
RUN pnpm --filter @hief/reputation build

FROM node:20-alpine AS runtime

RUN npm install -g pnpm && apk add --no-cache wget

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/common/package.json ./packages/common/
COPY packages/reputation/package.json ./packages/reputation/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/reputation/dist ./packages/reputation/dist

EXPOSE 3002

CMD ["node", "packages/reputation/dist/api/server.js"]
