FROM node:20-bullseye AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
RUN corepack enable
RUN corepack prepare pnpm@9.15.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts

RUN chown -R node:node /usr/src/app/node_modules

RUN pnpm exec prisma generate --schema=./apps/ai-service/prisma/schema.prisma

RUN pnpm run build ai-service


FROM node:20-bullseye AS production

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
COPY --from=builder --chown=node:node /usr/src/app/apps/ai-service/prisma ./apps/ai-service/prisma

USER node

CMD ["/bin/sh", "-c", "node_modules/.bin/prisma migrate deploy --schema=apps/ai-service/prisma/schema.prisma && node dist/apps/ai-service/apps/ai-service/src/main.js"]
