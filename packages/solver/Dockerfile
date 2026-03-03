FROM node:20-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/solver/package.json ./packages/solver/

RUN pnpm install --frozen-lockfile

COPY packages/common ./packages/common
COPY packages/solver ./packages/solver

RUN pnpm --filter @hief/common build
RUN pnpm --filter @hief/solver build

FROM node:20-alpine AS runtime

RUN npm install -g pnpm && apk add --no-cache wget

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/common/package.json ./packages/common/
COPY packages/solver/package.json ./packages/solver/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/solver/dist ./packages/solver/dist

EXPOSE 3004

CMD ["node", "packages/solver/dist/server.js"]
