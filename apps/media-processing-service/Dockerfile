FROM node:20-bullseye AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:4.3.9-0+deb11u2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm run build:media-processing


FROM node:20-bullseye AS production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:4.3.9-0+deb11u2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist

USER node

CMD ["node", "dist/apps/media-processing-service/main.js"]
