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
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm exec prisma generate --schema=./apps/monitoring-service/prisma/schema.prisma
RUN pnpm run build:monitoring

FROM node:20-alpine AS production

ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN sed -i \
  "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" \
  /etc/apk/repositories \
  && apk add --no-cache openssl

WORKDIR /usr/src/app
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
COPY --from=builder --chown=node:node /usr/src/app/apps/monitoring-service/prisma ./apps/monitoring-service/prisma

USER node
EXPOSE 3016
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:3016/health', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["/bin/sh", "-c", "node_modules/.bin/prisma migrate deploy --schema=apps/monitoring-service/prisma/schema.prisma && node dist/apps/monitoring-service/apps/monitoring-service/src/main.js"]
