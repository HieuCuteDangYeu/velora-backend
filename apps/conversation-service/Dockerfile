FROM node:20-alpine AS builder

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN sed -i \
  "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" \
  /etc/apk/repositories \
  && apk add --no-cache openssl

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Keep package files independent inside the Docker layer. pnpm's default
# import strategy may hardlink files from its content-addressable store;
# those hardlinks can be preserved when node_modules is copied into the
# runtime image and fail to unpack on containerd/overlayfs hosts.
RUN pnpm install --frozen-lockfile --ignore-scripts --package-import-method=copy

COPY . .

RUN pnpm exec prisma generate --schema=./apps/conversation-service/prisma/schema.prisma

RUN pnpm run build conversation-service


FROM node:20-alpine AS production

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN sed -i \
  "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" \
  /etc/apk/repositories \
  && apk add --no-cache openssl

WORKDIR /usr/src/app
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist

USER node

CMD ["node", "dist/apps/conversation-service/apps/conversation-service/src/main.js"]
