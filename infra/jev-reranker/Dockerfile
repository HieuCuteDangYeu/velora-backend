FROM python:3.12-slim

ARG JEFF_COMMIT=34b32f99a727c47b679adde33f4702a001e02979

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    JEFF_HOST=0.0.0.0 \
    JEFF_PORT=8000 \
    JEFF_MODEL=/models/gliformer-large-v1 \
    JEFF_MODEL_NAME=jev-local \
    JEFF_MODEL_ALIASES=jev-latest,jev \
    JEFF_BACKEND=torch \
    JEFF_DEVICE=cpu \
    JEFF_NOUL_MODE=yes_no \
    JEFF_ISOLATE=nouls \
    JEFF_STATE_FORMAT=json \
    JEFF_MAX_BATCH=4 \
    JEFF_MAX_WAIT_MS=10 \
    JEFF_MAX_QUEUE=64 \
    JEFF_MAX_STATE_CHARS=30000

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu 'torch==2.9.1+cpu' \
    && pip install --no-cache-dir \
      'gliformer>=0.1.1' \
      'fastapi>=0.115' \
      'uvicorn[standard]>=0.30' \
      'pydantic>=2.7' \
      'httpx>=0.27' \
      'huggingface-hub>=0.24'

RUN python -c "import urllib.request; urllib.request.urlretrieve('https://codeload.github.com/logan-markewich/jeff/tar.gz/${JEFF_COMMIT}', '/tmp/jeff.tar.gz')" \
    && pip install --no-cache-dir --no-deps /tmp/jeff.tar.gz \
    && rm -f /tmp/jeff.tar.gz

COPY infra/jev-reranker/entrypoint.sh /usr/local/bin/jev-reranker-entrypoint
RUN chmod 0755 /usr/local/bin/jev-reranker-entrypoint

VOLUME ["/models"]
EXPOSE 8000
WORKDIR /models
ENTRYPOINT ["/usr/local/bin/jev-reranker-entrypoint"]
