FROM node:20-bullseye AS base

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Production dependencies are installed once and copied into the runtime image.
# prunedAt is the only timestamp pnpm writes into node_modules, so it is pinned
# to keep the layer reproducible. --package-import-method=copy keeps hardlinks
# to pnpm's store out of the layer.
FROM base AS deps

RUN pnpm install --prod --frozen-lockfile --ignore-scripts --package-import-method=copy \
 && sed -i 's/^prunedAt:.*/prunedAt: Thu, 01 Jan 1970 00:00:00 GMT/' node_modules/.modules.yaml


# Debian 11 is end of life: deb.debian.org no longer serves its security
# packages, so the pinned ffmpeg (and its dependencies) come from the archive.
FROM base AS builder

RUN sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:4.3.9-0+deb11u2 \
 && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm run build:media-processing


FROM node:20-bullseye-slim AS production

WORKDIR /usr/src/app
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules

RUN sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:4.3.9-0+deb11u2 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /usr/src/app/dist ./dist

USER node

CMD ["node", "dist/apps/media-processing-service/main.js"]
