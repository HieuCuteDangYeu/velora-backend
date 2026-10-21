FROM node:24-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
  g++ \
  make \
  openssl \
  python3 \
  python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# The mediasoup worker is built here, with the toolchain from the base stage, so
# the runtime image only needs the resulting node_modules. The test fails the
# build if the worker binary is missing. prunedAt is the only timestamp pnpm
# writes into node_modules, so it is pinned to keep the layer reproducible.
# --package-import-method=copy keeps hardlinks to pnpm's store out of the layer.
FROM base AS deps

ENV MEDIASOUP_MAX_CORES=2

RUN pnpm install --prod --frozen-lockfile --ignore-scripts --package-import-method=copy \
  && pnpm rebuild mediasoup bcrypt \
  && node_modules/.bin/prisma --version \
  && ls node_modules/.pnpm/mediasoup@*/node_modules/mediasoup/worker/out/Release/mediasoup-worker \
  && sed -i 's/^prunedAt:.*/prunedAt: Thu, 01 Jan 1970 00:00:00 GMT/' node_modules/.modules.yaml


FROM base AS builder

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts

RUN pnpm exec prisma generate --schema=./apps/call-service/prisma/schema.prisma

RUN pnpm run build call-service


FROM node:24-bookworm-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/node_modules/@prisma/call-client ./node_modules/@prisma/call-client
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
COPY --from=builder --chown=node:node /usr/src/app/apps/call-service/prisma ./apps/call-service/prisma

USER node

# Call history is optional: without CALL_DATABASE_URL, or if its migration
# fails, calls still start and only the stored history is skipped.
CMD ["/bin/sh", "-c", "if [ -n \"$CALL_DATABASE_URL\" ]; then node_modules/.bin/prisma migrate deploy --schema=apps/call-service/prisma/schema.prisma || echo 'call history migration failed; calls continue without stored history' >&2; fi; exec node dist/apps/call-service/apps/call-service/src/main.js"]
