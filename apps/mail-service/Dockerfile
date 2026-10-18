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

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm run build mail-service


FROM node:20-alpine AS production

WORKDIR /usr/src/app
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist

USER node
CMD ["node", "dist/apps/mail-service/apps/mail-service/src/main.js"]
