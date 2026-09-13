FROM node:20-alpine AS builder

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm run build media-service


FROM node:20-alpine AS production

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN sed -i \
  "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" \
  /etc/apk/repositories \
  && apk add --no-cache ffmpeg

WORKDIR /usr/src/app
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist

USER node

CMD ["node", "dist/apps/media-service/apps/media-service/src/main.js"]
