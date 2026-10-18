FROM node:20-bullseye AS base

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Production dependencies are installed once and copied into the runtime image
# as its first layer. Keep this stage identical to the one in
# reel-indexing-service so both images share the node_modules layer. The engine
# download in prisma --version is only needed by that service. prunedAt is the
# only timestamp pnpm writes into node_modules, so it is pinned to keep the
# layer reproducible.
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
 && apt-get install -y --no-install-recommends ffmpeg=7:4.3.9-0+deb11u2 \
 && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm run build:media-processing


FROM node:20-bullseye AS production

WORKDIR /usr/src/app
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:4.3.9-0+deb11u2 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /usr/src/app/dist ./dist

USER node

CMD ["node", "dist/apps/media-processing-service/main.js"]
