'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessCapacity,
  parseDfOutput,
  parseMeminfo,
  parseModelVolumeSizes,
  parseRunningModelContainers,
} = require('./check-local-ai-capacity.cjs');

test('parses POSIX df output into byte counts and usage', () => {
  assert.deepEqual(
    parseDfOutput(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 104857600 20971520 83886080 20% /var/lib/docker\n',
    ),
    {
      filesystem: '/dev/root',
      totalBytes: 107374182400,
      usedBytes: 21474836480,
      freeBytes: 85899345920,
      usagePercent: 20,
      mountpoint: '/var/lib/docker',
    },
  );
});

test('parses available memory without confusing it with free memory', () => {
  const memory = parseMeminfo(
    [
      'MemTotal:       8000000 kB',
      'MemFree:         300000 kB',
      'MemAvailable:   5000000 kB',
      'SwapTotal:      4000000 kB',
      'SwapFree:        100000 kB',
    ].join('\n'),
  );
  assert.equal(memory.totalBytes, 8000000 * 1024);
  assert.equal(memory.availableBytes, 5000000 * 1024);
  assert.equal(memory.usedBytes, 3000000 * 1024);
  assert.equal(memory.swapFreeBytes, 100000 * 1024);
});

test('only reports local model containers', () => {
  assert.deepEqual(
    parseRunningModelContainers(
      [
        'microservices-boilerplate-rag-embedding-1 Up 2 minutes',
        'microservices-boilerplate-ai-service-1 Up 2 minutes',
        'microservices-boilerplate-rag-reranker-1 Up 1 minute',
      ].join('\n'),
    ),
    [
      {
        name: 'microservices-boilerplate-rag-embedding-1',
        status: 'Up 2 minutes',
      },
      {
        name: 'microservices-boilerplate-rag-reranker-1',
        status: 'Up 1 minute',
      },
    ],
  );
});

test('parses model volume sizes from docker system df verbose output', () => {
  assert.deepEqual(
    parseModelVolumeSizes(
      [
        'VOLUME NAME LINKS SIZE',
        'microservices-boilerplate_rag_embedding_cache 1 2.285GB',
        'microservices-boilerplate_rag_reranker_cache 1 2.288GB',
        'microservices-boilerplate_rabbitmq_data 1 349.1kB',
      ].join('\n'),
    ),
    {
      embedding: {
        name: 'microservices-boilerplate_rag_embedding_cache',
        size: '2.285GB',
      },
      reranker: {
        name: 'microservices-boilerplate_rag_reranker_cache',
        size: '2.288GB',
      },
    },
  );
});

test('blocks startup below the configured free-disk threshold', () => {
  const result = assessCapacity({
    disk: { freeBytes: 11 * 1024 ** 3 },
    memory: { availableBytes: 4 * 1024 ** 3 },
    docker: { available: true, containers: [] },
    minFreeDiskGb: 12,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons[0], /free disk/);
});

test('allows a read-only report when Docker is unavailable but never allows startup', () => {
  const result = assessCapacity({
    disk: { freeBytes: 20 * 1024 ** 3 },
    memory: { availableBytes: 4 * 1024 ** 3 },
    docker: { available: false, containers: [] },
    minFreeDiskGb: 12,
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasons, ['Docker status could not be inspected']);
});
