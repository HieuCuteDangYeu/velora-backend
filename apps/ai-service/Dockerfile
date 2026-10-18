FROM node:20-bookworm AS base

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Production dependencies are installed once and copied into the runtime image
# as its first layer, so keep this stage free of anything service-specific: the
# node_modules layer then has the same content on every build and Docker keeps
# one copy. prisma --version downloads the engines that prisma migrate deploy
# needs at start-up. prunedAt is the only timestamp pnpm writes into
# node_modules, so it is pinned to keep the layer reproducible.
# --package-import-method=copy keeps hardlinks to pnpm's store out of the layer.
FROM base AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

RUN pnpm install --prod --frozen-lockfile --ignore-scripts --package-import-method=copy \
 && node_modules/.bin/prisma --version \
 && sed -i 's/^prunedAt:.*/prunedAt: Thu, 01 Jan 1970 00:00:00 GMT/' node_modules/.modules.yaml


FROM base AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm exec prisma generate --schema=./apps/ai-service/prisma/schema.prisma

RUN pnpm run build ai-service


FROM node:20-bookworm-slim AS production

WORKDIR /usr/src/app
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /usr/src/app/node_modules/@prisma/ai-client ./node_modules/@prisma/ai-client
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
COPY --from=builder --chown=node:node /usr/src/app/apps/ai-service/prisma ./apps/ai-service/prisma

USER node

CMD ["/bin/sh", "-c", "node_modules/.bin/prisma migrate deploy --schema=apps/ai-service/prisma/schema.prisma && node dist/apps/ai-service/apps/ai-service/src/main.js"]
