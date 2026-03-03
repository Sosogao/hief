FROM node:20-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/policy/package.json ./packages/policy/

RUN pnpm install --frozen-lockfile

COPY packages/common ./packages/common
COPY packages/policy ./packages/policy

RUN pnpm --filter @hief/common build
RUN pnpm --filter @hief/policy build

FROM node:20-alpine AS runtime

RUN npm install -g pnpm && apk add --no-cache wget

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/common/package.json ./packages/common/
COPY packages/policy/package.json ./packages/policy/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/policy/dist ./packages/policy/dist

EXPOSE 3003

CMD ["node", "packages/policy/dist/server.js"]
