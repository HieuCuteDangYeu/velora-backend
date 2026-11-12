#!/usr/bin/env node
'use strict';
/**
 * Scores `datasets/rag-semantic-live-v1.jsonl` against the LIVE reel index.
 * Read-only: it embeds the question, calls `index.search_chunks`, optionally
 * reranks the top texts with `ai.rerank_texts`, and writes only the result file.
 *
 * `run` needs RabbitMQ and @nestjs/microservices, so run it inside the
 * content-service container (same recipe as recommendation-rerank-benchmark.cjs):
 *
 *   docker cp eval/rag/semantic-live-eval.cjs eval/rag/semantic-live-eval-lib.cjs \
 *     eval/rag/datasets/rag-semantic-live-v1.jsonl <content-service>:/usr/src/app/
 *   docker exec <content-service> node semantic-live-eval.cjs run \
 *     --cases rag-semantic-live-v1.jsonl --out run-a.json [--split heldout] [--limit 50]
 *   docker cp <content-service>:/usr/src/app/run-a.json .benchmarks/semantic-live-run-a.json
 *   docker exec -u root <content-service> rm /usr/src/app/semantic-live-eval*.cjs \
 *     /usr/src/app/rag-semantic-live-v1.jsonl /usr/src/app/run-a.json
 *
 * `compare` is pure and runs anywhere:
 *
 *   node eval/rag/semantic-live-eval.cjs compare .benchmarks/run-a.json .benchmarks/run-b.json [--stage rerank]
 *
 * Choices that keep the score honest:
 *  - Only REVIEWED cases count by default (`--include-candidates` for a smoke run).
 *  - A case whose embedding, search or rerank call fails is `unavailable` and
 *    left out of the means; the denominator is reported, never scored as a miss.
 *  - The query is the question text as typed. Production also uses the planner's
 *    rewritten keyword query, so absolute numbers are a floor for the real
 *    path; use the set to compare two builds, not to quote an absolute score.
 *  - Calls are sequential: the TEI reranker admits one request at a time and
 *    shares capacity with live chat. Run off-peak.
 *  - Never tune on the `heldout` or `fresh` splits; report them separately.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const lib = require('./semantic-live-eval-lib.cjs');

const SEARCH_LIMIT = 30;
const RERANK_TOP = 12;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) {
      args._.push(argv[i]);
      continue;
    }
    const [name, inline] = argv[i].slice(2).split('=', 2);
    const next = argv[i + 1];
    if (inline !== undefined) args[name] = inline;
    else if (next && !next.startsWith('--')) {
      args[name] = next;
      i += 1;
    } else args[name] = true;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function selectCases(rows, args) {
  const errors = lib.validateDataset(rows);
  if (errors.length)
    throw new Error(`invalid dataset:\n${errors.slice(0, 10).join('\n')}`);
  const statuses = new Set(
    args['include-candidates'] ? ['REVIEWED', 'CANDIDATE'] : ['REVIEWED'],
  );
  let cases = rows.filter((r) => statuses.has(r.status));
  if (args.split && args.split !== 'all')
    cases = cases.filter((r) => r.split === args.split);
  if (args.limit) cases = cases.slice(0, Number(args.limit));
  return cases;
}

function rabbitDeps() {
  const { ClientProxyFactory, Transport } = require('@nestjs/microservices');
  const { firstValueFrom, timeout } = require('rxjs');
  if (!process.env.RABBITMQ_URL)
    throw new Error(
      'RABBITMQ_URL is not set; run inside the content-service container',
    );
  return {
    firstValueFrom,
    timeout,
    client: (queue) =>
      ClientProxyFactory.create({
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL],
          queue,
          queueOptions: { durable: true },
        },
      }),
  };
}

async function run(args, deps = rabbitDeps()) {
  const ai = deps.client('ai_queue');
  const index = deps.client('reel_index_query');
  await Promise.all([ai.connect(), index.connect()]);
  const rpc = (c, pattern, data, ms) =>
    deps.firstValueFrom(c.send(pattern, data).pipe(deps.timeout(ms)));

  const raw = fs.readFileSync(args.cases, 'utf8');
  const cases = selectCases(lib.parseJsonl(raw), args);
  if (!cases.length)
    throw new Error(
      'no cases selected (REVIEWED only unless --include-candidates)',
    );

  const meta = {
    datasetVersion: lib.DATASET_VERSION,
    casesSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    selection: {
      split: args.split ?? 'all',
      includeCandidates: Boolean(args['include-candidates']),
      limit: args.limit ?? null,
    },
    startedAt: new Date().toISOString(),
    indexVersions: new Set(),
    embedding: null,
    searchLimit: SEARCH_LIMIT,
    rerankTop: RERANK_TOP,
  };
  const delay = Number(args['delay-ms'] ?? 150);
  const perCase = [];

  for (const [i, c] of cases.entries()) {
    const grades = new Map(c.relevant.map((r) => [r.evidenceId, r.grade]));
    const entry = {
      id: c.id,
      split: c.split,
      tags: [...c.tags, c.language, c.source],
      seriesId: c.seriesId,
    };
    try {
      const { embedding } = await rpc(
        ai,
        'ai.generate_embedding',
        { text: c.question, taskType: 'RETRIEVAL_QUERY' },
        20000,
      );
      meta.embedding = {
        model: embedding.model,
        version: embedding.version,
        dimensions: embedding.dimensions,
      };
      const hits = await rpc(
        index,
        'index.search_chunks',
        {
          queryText: c.question,
          queryEmbedding: embedding.values,
          queryEmbeddingModel: embedding.model,
          queryEmbeddingVersion: embedding.version,
          limit: SEARCH_LIMIT,
          candidateLimit: 200,
        },
        15000,
      );
      if (!Array.isArray(hits)) throw new Error('search returned a non-array');
      hits.forEach(
        (h) => h.indexVersion && meta.indexVersions.add(h.indexVersion),
      );
      const retrieval = hits.map((h) => h.id);
      entry.retrieval = {
        ranked: retrieval,
        ...lib.caseMetrics(retrieval, grades, { cutoff: SEARCH_LIMIT }),
      };

      if (!args['no-rerank'] && hits.length > 1) {
        const top = hits.slice(0, RERANK_TOP);
        const { scores } = await rpc(
          ai,
          'ai.rerank_texts',
          {
            queryText: c.question,
            texts: top.map((h) =>
              String(h.evidenceText ?? h.text).slice(0, 1500),
            ),
            budgetMs: 8000,
          },
          12000,
        );
        if (!Array.isArray(scores) || scores.length !== top.length)
          throw new Error('rerank returned the wrong number of scores');
        const reranked = top
          .map((h, k) => ({ id: h.id, s: scores[k] }))
          .sort((a, b) => b.s - a.s)
          .map((x) => x.id)
          .concat(hits.slice(RERANK_TOP).map((h) => h.id));
        entry.rerank = {
          ranked: reranked,
          ...lib.caseMetrics(reranked, grades, { cutoff: SEARCH_LIMIT }),
        };
      }
    } catch (error) {
      entry.unavailable = String(error?.message ?? error).slice(0, 200);
    }
    perCase.push(entry);
    process.stderr.write(`\r${i + 1}/${cases.length}`);
    if (delay) await sleep(delay);
  }
  process.stderr.write('\n');
  await Promise.all([ai.close(), index.close()]);

  const result = buildResult(
    {
      ...meta,
      indexVersions: [...meta.indexVersions].sort(),
      finishedAt: new Date().toISOString(),
    },
    perCase,
  );
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  printSummary(result);
  return result;
}

function buildResult(meta, perCase) {
  const stages = {};
  for (const stage of ['retrieval', 'rerank']) {
    const scored = perCase
      .filter((c) => c[stage])
      .map((c) => ({ ...c[stage], tags: c.tags, split: c.split }));
    if (!scored.length) continue;
    stages[stage] = {
      overall: lib.summarize(scored),
      bySplit: lib.summarizeBy(scored, (c) => c.split),
      byTag: lib.summarizeBy(scored, (c) => c.tags),
    };
  }
  return {
    meta,
    cases: perCase.length,
    unavailable: perCase.filter((c) => c.unavailable).length,
    stages,
    perCase,
  };
}

function printSummary(result) {
  console.log(
    JSON.stringify({
      cases: result.cases,
      unavailable: result.unavailable,
      indexVersions: result.meta.indexVersions,
    }),
  );
  for (const [stage, s] of Object.entries(result.stages))
    console.log(stage, JSON.stringify(s.overall));
}

function compareRuns(a, b, stage = 'rerank') {
  const warnings = [];
  if (
    JSON.stringify(a.meta.indexVersions) !==
    JSON.stringify(b.meta.indexVersions)
  )
    warnings.push(
      `index versions differ: ${a.meta.indexVersions} vs ${b.meta.indexVersions} (a reindex changes scores on its own)`,
    );
  if (a.meta.casesSha256 !== b.meta.casesSha256)
    warnings.push('case files differ; only shared cases are compared');
  const bById = new Map(
    b.perCase.filter((c) => c[stage]).map((c) => [c.id, c]),
  );
  const shared = a.perCase.filter((c) => c[stage] && bById.has(c.id));
  if (shared.length < 2)
    throw new Error(`fewer than 2 shared scored cases for stage ${stage}`);
  if (shared.length < 150)
    warnings.push(
      `only ${shared.length} shared cases: differences under ~0.05 are noise at this size`,
    );
  const metrics = {};
  for (const metric of ['rr', 'recall1', 'recall5', 'ndcg10']) {
    const x = shared.map((c) => c[stage][metric]);
    const y = shared.map((c) => bById.get(c.id)[stage][metric]);
    metrics[metric] = {
      a: Number(lib.summarize(shared.map((c) => c[stage]))[metric]),
      ...lib.pairedBootstrap(x, y),
    };
  }
  return { stage, sharedCases: shared.length, warnings, metrics };
}

function compare(args) {
  const [aFile, bFile] = args._.slice(1);
  if (!aFile || !bFile)
    throw new Error(
      'usage: compare <run-a.json> <run-b.json> [--stage retrieval|rerank]',
    );
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(
    JSON.stringify(
      compareRuns(read(aFile), read(bFile), args.stage ?? 'rerank'),
      null,
      2,
    ),
  );
}

module.exports = { buildResult, compareRuns, run, selectCases };

if (require.main === module)
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args._[0] === 'run') {
      if (!args.cases || !args.out)
        throw new Error(
          'usage: run --cases <file.jsonl> --out <result.json> [--split dev|heldout|fresh|all] [--limit N] [--no-rerank] [--include-candidates]',
        );
      return await run(args);
    }
    if (args._[0] === 'compare') return compare(args);
    throw new Error('usage: semantic-live-eval.cjs run|compare ...');
  })().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
