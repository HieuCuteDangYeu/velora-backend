# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS node-build

ARG PNPM_VERSION=9.15.0

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml nest-cli.json tsconfig.json tsconfig.build.json .npmrc ./
COPY apps ./apps
COPY libs ./libs
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm run prisma:generate:conversation \
  && pnpm run prisma:generate:ai \
  && pnpm run prisma:generate:reel-indexing
RUN pnpm run build:ai

FROM python:3.12-slim-bookworm AS runtime

ARG EVALUATOR_SHA=unknown
ARG PRODUCTION_SHA=unknown
ARG PNPM_VERSION=9.15.0

ENV COREPACK_HOME=/opt/corepack \
  DIAGNOSTIC_TOOL_SHA=${EVALUATOR_SHA} \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  PATH=/workspace/eval/rag/.venv/bin:/opt/corepack:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LABEL org.opencontainers.image.revision=${EVALUATOR_SHA} \
  io.velora.production-sha=${PRODUCTION_SHA} \
  io.velora.image-purpose=rag-evaluation

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl adduser \
  && pip install --no-cache-dir uv==0.9.14 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node-build /usr/local /usr/local

RUN corepack enable \
  && corepack install --global pnpm@${PNPM_VERSION}

RUN addgroup --gid 1000 eval \
  && adduser --uid 1000 --gid 1000 --disabled-password --gecos '' eval \
  && mkdir -p /workspace/eval/rag/results \
    /workspace/eval/rag/experiments \
    /workspace/test-data/reel-integration/ami/reports/state \
  && chown -R eval:eval /opt/corepack /workspace/eval/rag/results \
    /workspace/eval/rag/experiments /workspace/test-data/reel-integration/ami/reports

WORKDIR /workspace

COPY --from=node-build --chown=eval:eval /workspace/node_modules ./node_modules
COPY --from=node-build --chown=eval:eval /workspace/dist ./dist
COPY --from=node-build --chown=eval:eval /workspace/scripts ./scripts
COPY --chown=eval:eval package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=eval:eval eval/rag/pyproject.toml eval/rag/uv.lock ./eval/rag/
COPY --chown=eval:eval eval/rag/README.md ./eval/rag/README.md
COPY --chown=eval:eval eval/rag/src ./eval/rag/src
COPY --chown=eval:eval eval/rag/tests ./eval/rag/tests
COPY --chown=eval:eval eval/rag/config ./eval/rag/config
COPY --chown=eval:eval eval/rag/datasets ./eval/rag/datasets
COPY --chown=root:root eval/rag/docker-entrypoint.sh /usr/local/bin/rag-eval-entrypoint

RUN chown -R eval:eval /workspace/eval/rag

RUN chmod 755 /usr/local/bin/rag-eval-entrypoint

USER eval

RUN uv sync --frozen --directory /workspace/eval/rag

USER root

ENTRYPOINT ["/usr/local/bin/rag-eval-entrypoint"]
CMD ["sh"]
