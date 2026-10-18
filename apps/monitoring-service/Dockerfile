FROM node:20-alpine AS base

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Production dependencies are installed once and copied into the runtime image
# as its first layer, so keep this stage identical in every node:20-alpine
# service: the node_modules layer then has the same content in all of them and
# Docker stores it once. prisma --version downloads the engines that prisma
# migrate deploy needs at start-up. prunedAt is the only timestamp pnpm writes
# into node_modules, so it is pinned to keep the layer reproducible.
# --package-import-method=copy keeps hardlinks to pnpm's store out of the layer.
FROM base AS deps

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN sed -i \
  "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" \
  /etc/apk/repositories \
  && apk add --no-cache openssl

RUN pnpm install --prod --frozen-lockfile --ignore-scripts --package-import-method=copy \
  && node_modules/.bin/prisma --version \
  && sed -i 's/^prunedAt:.*/prunedAt: Thu, 01 Jan 1970 00:00:00 GMT/' node_modules/.modules.yaml


FROM base AS builder

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN sed -i \
  "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" \
  /etc/apk/repositories \
  && apk add --no-cache openssl

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm exec prisma generate --schema=./apps/monitoring-service/prisma/schema.prisma

RUN pnpm run build:monitoring


FROM node:20-alpine AS production

WORKDIR /usr/src/app
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN sed -i \
  "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" \
  /etc/apk/repositories \
  && apk add --no-cache openssl

COPY --from=builder --chown=node:node /usr/src/app/node_modules/@prisma/monitoring-client ./node_modules/@prisma/monitoring-client
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
COPY --from=builder --chown=node:node /usr/src/app/apps/monitoring-service/prisma ./apps/monitoring-service/prisma

USER node
EXPOSE 3016
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:3016/health', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["/bin/sh", "-c", "node_modules/.bin/prisma migrate deploy --schema=apps/monitoring-service/prisma/schema.prisma && node dist/apps/monitoring-service/apps/monitoring-service/src/main.js"]
