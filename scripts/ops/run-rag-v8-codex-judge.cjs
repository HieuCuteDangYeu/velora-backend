#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildDimensionPrompt } = require('./rag-semantic-judge.cjs');
const {
  DIMENSIONS,
  isApplicable,
} = require('./rag-evaluation-applicability.cjs');
const { fingerprint } = require('./rag-evaluation-contract.cjs');
const { benchmarkEvaluations } = require('./run-langfuse-live-benchmark.cjs');
const {
  codexEnvironment,
  hasChatGptAuthentication,
  installedCodexVersion,
  model,
  runCodexDimension,
} = require('./run-rag-codex-judge.cjs');

const root = path.resolve(__dirname, '../..');
const runDir = path.join(root, '.benchmarks/rag-remediation-v8-20261026-01');
const datasetDir = path.join(runDir, 'dataset-v8-source-disjoint-20261026-03');
const stateFile = path.join(
  runDir,
  'live-benchmark-state-v3/rag-v8-live-2360fcb32fd0-20261026-01.state.json',
);
const snapshotFile = path.join(
  runDir,
  'source/content-index-snapshot-v2-safe.json',
);
const previousOutputFile = path.join(
  runDir,
  'codex-judge-v8-development-v1.json',
);
const outputFile = path.join(runDir, 'codex-judge-v8-development-v2.json');

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(descriptor, `${process.pid}\n`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.closeSync(descriptor);
    fs.rmSync(file, { force: true });
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}

function scoreValue(scores, name) {
  return scores.find((score) => score.name === name)?.value;
}

function indexedContext(output, snapshot, options = {}) {
  const documents = new Map(
    snapshot.documents.map((item) => [item.reelId, item]),
  );
  const metadata = new Map(
    (options.includeMetadata === false
      ? []
      : (snapshot.contentIndexMetadata ?? [])
    ).map((item) => [
      `reel:${item.id}`,
      {
        ...item,
        evidenceType: 'METADATA',
        evidenceText: [
          item.title ? `Title: ${item.title}` : null,
          Array.isArray(item.tags) && item.tags.length
            ? `Tags: ${item.tags.join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ]),
  );
  const evidence = new Map(
    [...snapshot.transcriptChunks, ...snapshot.reviewedVisualScenes].map(
      (item) => [item.id, item],
    ),
  );
  const selectedIds = [
    ...(output.rerankedEvidenceIds?.length
      ? output.rerankedEvidenceIds
      : (output.retrievedEvidenceIds ?? [])),
  ];
  const result = [];
  const seen = new Set();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = evidence.get(id) ?? metadata.get(id);
    const reelId = item?.reelId ?? String(id).split(':')[1] ?? '';
    result.push(
      item
        ? {
            title: documents.get(reelId)?.title,
            evidenceType:
              item.evidenceType ||
              (id.includes(':visual:') ? 'VISUAL' : 'TRANSCRIPT'),
            startTime: item.startTime,
            endTime: item.endTime,
            evidenceText: String(item.evidenceText ?? '').slice(0, 2_000),
            sourceId: id,
          }
        : {
            evidenceType: 'UNKNOWN',
            evidenceText:
              'Retrieved source text is missing from the frozen snapshot.',
            sourceId: id,
          },
    );
    if (result.length >= 12) break;
  }
  for (const citation of output.citations ?? []) {
    if (!citation?.evidenceId || seen.has(citation.evidenceId)) continue;
    seen.add(citation.evidenceId);
    result.push({
      title: citation.title,
      evidenceType: citation.evidenceType,
      startTime: citation.startTime,
      endTime: citation.endTime,
      evidenceText: String(citation.quote ?? citation.evidenceText ?? '').slice(
        0,
        2_000,
      ),
      sourceId: citation.evidenceId,
    });
  }
  return result;
}

function selectCases(items, state) {
  const development = items.filter(
    (item) => item.metadata?.split === 'DEVELOPMENT',
  );
  const selected = [];
  for (const bucket of [
    'VISUAL',
    'COMBINED',
    'METADATA',
    'MULTI_REEL',
    'ABSTENTION',
  ]) {
    const cases = development.filter(
      (item) => item.metadata?.bucket === bucket,
    );
    if (cases.length < (bucket === 'ABSTENTION' ? 1 : 8))
      throw new Error(`Insufficient V8 development cases in ${bucket}`);
    selected.push(...(bucket === 'ABSTENTION' ? cases : cases.slice(0, 8)));
  }
  const transcriptCases = development
    .filter((item) => item.metadata?.bucket === 'TRANSCRIPT')
    .map((item) => ({
      item,
      score:
        scoreValue(
          benchmarkEvaluations(
            item.input,
            item.expectedOutput,
            state.cases[item.id].output,
          ),
          'answer_token_f1',
        ) ?? 0,
    }))
    .sort((a, b) => a.score - b.score || a.item.id.localeCompare(b.item.id));
  if (transcriptCases.length < 8)
    throw new Error('Insufficient V8 development transcript cases');
  const low = transcriptCases.slice(0, 4);
  const high = transcriptCases.slice(-4);
  selected.push(...low.map((row) => row.item), ...high.map((row) => row.item));
  const unique = [
    ...new Map(selected.map((item) => [item.id, item])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  if (
    unique.length !== 44 ||
    new Set(unique.map((item) => item.id)).size !== 44
  )
    throw new Error(
      'V8 Codex judge sample must contain 44 unique development cases',
    );
  return unique;
}

function loadFrozenRun() {
  const manifest = readJson(path.join(datasetDir, 'manifest.json'));
  const items = readJson(path.join(datasetDir, 'cases.json'));
  const state = readJson(stateFile);
  const snapshot = readJson(snapshotFile);
  if (
    manifest.datasetSha256 !== fingerprint(items) ||
    state.datasetName !== 'velora/rag-v8-source-disjoint-20261026-03' ||
    state.serviceReleaseSha !== '2360fcb32fd09da0c106fcb18bb819045c8ac705' ||
    typeof state.datasetFingerprint !== 'string' ||
    JSON.stringify(state.itemIds) !==
      JSON.stringify(
        [...items].sort((a, b) => a.id.localeCompare(b.id)).map((x) => x.id),
      ) ||
    items.length !== 136 ||
    Object.values(state.cases ?? {}).length !== items.length ||
    Object.values(state.cases ?? {}).some(
      (entry) => entry.status !== 'COMPLETED',
    )
  )
    throw new Error(
      'V8 Codex judge requires the exact completed frozen 136-case run',
    );
  const selected = selectCases(items, state);
  const sourceSnapshotSha256 = fingerprint(snapshot);
  const contexts = new Map(
    selected.map((item) => [
      item.id,
      indexedContext(state.cases[item.id].output, snapshot),
    ]),
  );
  return {
    manifest,
    items,
    state,
    snapshot,
    selected,
    contexts,
    sourceSnapshotSha256,
  };
}

function promptFor(dimension, item, output, context) {
  return buildDimensionPrompt(dimension, {
    question: item.input?.question,
    referenceAnswer:
      item.expectedOutput?.referenceAnswer ??
      item.expectedOutput?.answer ??
      item.expectedOutput?.acceptedAnswers ??
      '',
    generatedAnswer: output.answer ?? '',
    context,
    answerType: item.metadata?.answerType,
    policyAssertions: item.expectedOutput?.assertions,
    expectedEvidenceTypes: item.expectedOutput?.expectedEvidenceTypes,
  });
}

function applicableDimensions(item) {
  return DIMENSIONS.filter((dimension) => isApplicable(item, dimension));
}

function selfTest() {
  const bucketCounts = {
    VISUAL: 8,
    COMBINED: 8,
    METADATA: 8,
    MULTI_REEL: 8,
    ABSTENTION: 4,
    TRANSCRIPT: 8,
  };
  const answerTypes = {
    VISUAL: 'SCENE_DESCRIPTION',
    COMBINED: 'MULTIMODAL_FACTS',
    METADATA: 'EXACT_TITLE',
    MULTI_REEL: 'MULTI_SOURCE_FACTS',
    ABSTENTION: 'ABSTENTION',
    TRANSCRIPT: 'SEMANTIC_FACTS',
  };
  const items = Object.entries(bucketCounts).flatMap(([bucket, count]) =>
    Array.from({ length: count }, (_, index) => {
      const id = `${bucket}-${index}`;
      return {
        id,
        input: {
          question: 'What fact is supported?',
          evidenceIds: ['reel:r1:chunk:0'],
        },
        expectedOutput: {
          answer: 'source answer',
          answerType: answerTypes[bucket],
          evidenceIds: ['reel:r1:chunk:0'],
          expectedEvidenceTypes: ['TRANSCRIPT'],
          assertions: ['Use only source evidence.'],
        },
        metadata: {
          split: 'DEVELOPMENT',
          bucket,
          answerType: answerTypes[bucket],
        },
      };
    }),
  );
  const output = {
    answer: 'candidate answer',
    rerankedEvidenceIds: ['reel:r1:chunk:0'],
    retrievedEvidenceIds: ['reel:r1:chunk:0'],
    citations: [],
    executionHealth: { status: 'AVAILABLE' },
  };
  const state = {
    cases: Object.fromEntries(
      items.map((item) => [item.id, { status: 'COMPLETED', output }]),
    ),
  };
  const selected = selectCases(items, state);
  const snapshot = {
    documents: [{ reelId: 'r1', title: 'Fixture Reel' }],
    contentIndexMetadata: [
      { id: 'r1', title: 'Fixture Reel', tags: ['fixture'] },
    ],
    transcriptChunks: [
      {
        id: 'reel:r1:chunk:0',
        reelId: 'r1',
        evidenceText: 'fixture source text',
        startTime: 0,
        endTime: 1,
      },
    ],
    reviewedVisualScenes: [],
  };
  assert.equal(selected.length, 44);
  assert.equal(new Set(selected.map((item) => item.id)).size, 44);
  for (const item of selected) {
    const context = indexedContext(output, snapshot);
    assert(Array.isArray(context));
    for (const dimension of applicableDimensions(item)) {
      const prompt = promptFor(dimension, item, output, context);
      assert(!prompt.includes(item.id));
    }
  }
  assert.equal(
    selected.filter((item) => item.metadata.bucket === 'ABSTENTION').length,
    4,
  );
  assert.equal(
    selected.filter((item) => item.metadata.bucket === 'COMBINED').length,
    8,
  );
  assert.equal(
    indexedContext({ rerankedEvidenceIds: ['missing-evidence'] }, snapshot)[0]
      .evidenceType,
    'UNKNOWN',
  );
  assert.match(
    indexedContext({ rerankedEvidenceIds: ['reel:r1'] }, snapshot)[0]
      .evidenceText,
    /Tags: fixture/,
  );
  assert.equal(
    indexedContext({ rerankedEvidenceIds: ['reel:r1'] }, snapshot, {
      includeMetadata: false,
    })[0].evidenceType,
    'UNKNOWN',
  );
  const metadataItem = {
    id: 'metadata-case',
    input: { question: 'What is the exact Reel title?' },
    expectedOutput: { referenceAnswer: 'Fixture Reel' },
    metadata: { bucket: 'METADATA', answerType: 'EXACT_TITLE' },
  };
  const metadataOutput = {
    answer: 'Fixture Reel',
    rerankedEvidenceIds: ['reel:r1'],
    citations: [],
  };
  const oldMetadataContext = indexedContext(metadataOutput, snapshot, {
    includeMetadata: false,
  });
  const newMetadataContext = indexedContext(metadataOutput, snapshot);
  assert.notEqual(
    promptFor('faithfulness', metadataItem, metadataOutput, oldMetadataContext),
    promptFor('faithfulness', metadataItem, metadataOutput, newMetadataContext),
  );
  assert.equal(
    promptFor(
      'factualCorrectness',
      metadataItem,
      metadataOutput,
      oldMetadataContext,
    ),
    promptFor(
      'factualCorrectness',
      metadataItem,
      metadataOutput,
      newMetadataContext,
    ),
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-v8-codex-lock-'));
  const lockPath = path.join(tempDir, 'judge.lock');
  const release = acquireLock(lockPath);
  assert.throws(() => acquireLock(lockPath), /EEXIST|file already exists/i);
  release();
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.stdout.write(
    'V8 Codex judge self-check passed (44 development cases)\n',
  );
}

function calibrationMetrics(cases) {
  const result = {};
  for (const dimension of DIMENSIONS) {
    const scores = cases
      .map((entry) => entry.scores?.[dimension]?.score)
      .filter(Number.isFinite);
    if (scores.length)
      result[dimension] = {
        count: scores.length,
        mean: scores.reduce((sum, value) => sum + value, 0) / scores.length,
        passCount: scores.filter((score) => score >= 0.8).length,
        failCount: scores.filter((score) => score < 0.5).length,
      };
  }
  return result;
}

async function main() {
  const args = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg?.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) args[name] = inline;
    else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
      args[name] = process.argv[++i];
    else args[name] = true;
  }
  if (args['self-test']) return selfTest();
  const data = loadFrozenRun();
  const cliVersion = installedCodexVersion();
  const sampleIds = data.selected.map((item) => item.id);
  const contextHashes = Object.fromEntries(
    data.selected.map((item) => [
      item.id,
      fingerprint(data.contexts.get(item.id)),
    ]),
  );
  const promptsById = new Map(
    data.selected.map((item) => {
      const output = data.state.cases[item.id].output;
      const context = data.contexts.get(item.id);
      return [
        item.id,
        Object.fromEntries(
          applicableDimensions(item).map((dimension) => [
            dimension,
            promptFor(dimension, item, output, context),
          ]),
        ),
      ];
    }),
  );
  const promptHashes = Object.fromEntries(
    [...promptsById].map(([caseId, prompts]) => [
      caseId,
      Object.fromEntries(
        Object.entries(prompts).map(([dimension, prompt]) => [
          dimension,
          fingerprint(prompt),
        ]),
      ),
    ]),
  );
  const judgeFingerprint = fingerprint({
    version: 'codex-gpt-6-luna-v8-development-v2-metadata-context',
    model,
    cliVersion,
    evaluatorVersion: 'velora-rag-evaluation-v6-dimension-prompts',
    datasetSha256: data.manifest.datasetSha256,
    sourceSnapshotSha256: data.sourceSnapshotSha256,
    sampleIds,
    contextHashes,
    promptHashes,
    effort: 'default',
  });
  const outputPath = path.resolve(args.output || outputFile);
  acquireLock(`${outputPath}.lock`);
  const previousPath = path.resolve(args['reuse-from'] || previousOutputFile);
  const previousReport = fs.existsSync(previousPath)
    ? readJson(previousPath)
    : null;
  if (
    previousReport &&
    (previousReport.status !== 'COMPLETE' ||
      previousReport.sourceDatasetSha256 !== data.manifest.datasetSha256 ||
      previousReport.model !== model ||
      previousReport.codexCliVersion !== cliVersion ||
      JSON.stringify(previousReport.sampleIds) !== JSON.stringify(sampleIds))
  )
    throw new Error(
      'Prior V8 judge report does not match the frozen development sample',
    );
  let report = fs.existsSync(outputPath)
    ? readJson(outputPath)
    : {
        schemaVersion: 'codex-rag-v8-development-judge-v2',
        provider: 'codex-chatgpt-subscription',
        model,
        codexCliVersion: cliVersion,
        judgeFingerprint,
        previousJudgeFingerprint: previousReport?.judgeFingerprint ?? null,
        evaluatorVersion: 'velora-rag-evaluation-v6-dimension-prompts',
        sourceDatasetSha256: data.manifest.datasetSha256,
        sourceSnapshotSha256: data.sourceSnapshotSha256,
        contextVersion: 'v2-content-index-metadata',
        contextHashes,
        promptHashes,
        sourceRunId: data.state.runId,
        serviceImageSha: data.state.serviceReleaseSha,
        sourceStateSha256: sha256(stateFile),
        traceReleaseValues: [
          ...new Set(
            Object.values(data.state.cases).map(
              (x) => x.output.release || 'MISSING',
            ),
          ),
        ].sort(),
        contextBasis:
          'RERANKED_SOURCE_TEXT_AND_REEL_METADATA_RECONSTRUCTED_FROM_FROZEN_INDEX_SNAPSHOT_AND_CITATION_EXCERPTS',
        contextCaptureAvailable: false,
        sampleSize: sampleIds.length,
        sampleIds,
        cases: {},
        status: 'IN_PROGRESS',
      };
  if (
    report.judgeFingerprint !== judgeFingerprint ||
    report.sampleSize !== sampleIds.length ||
    JSON.stringify(report.sampleIds) !== JSON.stringify(sampleIds)
  )
    throw new Error(
      'Existing V8 Codex judge checkpoint does not match the frozen sample',
    );
  if (previousReport && !Object.keys(report.cases).length) {
    let reusedScores = 0;
    for (const item of data.selected) {
      const caseId = item.id;
      const previousCase = previousReport.cases[caseId];
      const output = data.state.cases[caseId].output;
      const priorContext = indexedContext(output, data.snapshot, {
        includeMetadata: false,
      });
      const priorScores = {};
      for (const dimension of applicableDimensions(item)) {
        const oldPrompt = promptFor(dimension, item, output, priorContext);
        const newPrompt = promptsById.get(caseId)[dimension];
        const priorScore = previousCase?.scores?.[dimension];
        if (oldPrompt === newPrompt && typeof priorScore?.score === 'number') {
          priorScores[dimension] = priorScore;
          reusedScores += 1;
        }
      }
      if (Object.keys(priorScores).length)
        report.cases[caseId] = {
          ...previousCase,
          scores: priorScores,
        };
    }
    report.reusedScores = reusedScores;
    writeJsonAtomic(outputPath, report);
  }
  const login = spawnSync('codex', ['login', 'status'], {
    encoding: 'utf8',
    env: codexEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  if (login.status !== 0 || !hasChatGptAuthentication(login))
    throw new Error(
      'Codex judge requires saved ChatGPT subscription authentication',
    );
  const limit = args.limit ? Number.parseInt(args.limit, 10) : sampleIds.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > sampleIds.length)
    throw new Error('--limit must be between 1 and 44');
  const workItems = data.selected.slice(0, limit);
  const totalApplicableScores = workItems.reduce(
    (sum, item) => sum + applicableDimensions(item).length,
    0,
  );
  let completedApplicableScores = workItems.reduce(
    (sum, item) =>
      sum +
      applicableDimensions(item).filter(
        (dimension) =>
          typeof report.cases[item.id]?.scores?.[dimension]?.score === 'number',
      ).length,
    0,
  );
  for (const item of workItems) {
    const caseId = item.id;
    const saved = report.cases[caseId] ?? {
      caseId,
      bucket: item.metadata.bucket,
      answerType: item.metadata.answerType,
      split: item.metadata.split,
      traceId: data.state.cases[caseId].output.traceId,
      productionExecutionId:
        data.state.cases[caseId].output.productionExecutionId,
      executionHealth:
        data.state.cases[caseId].output.executionHealth?.status || 'UNKNOWN',
      contextEvidenceIds: data.contexts.get(caseId).map((e) => e.sourceId),
      contextSha256: contextHashes[caseId],
      scores: {},
    };
    const output = data.state.cases[caseId].output;
    for (const dimension of applicableDimensions(item)) {
      if (typeof saved.scores[dimension]?.score === 'number') continue;
      try {
        saved.scores[dimension] = runCodexDimension(
          dimension,
          promptsById.get(caseId)[dimension],
        );
      } catch (error) {
        saved.scores[dimension] = {
          error: /429|rate|limit|quota|usage/i.test(String(error.message))
            ? 'CODEX_USAGE_LIMIT'
            : 'CODEX_JUDGE_ERROR',
        };
        report.cases[caseId] = saved;
        report.metrics = calibrationMetrics(Object.values(report.cases));
        writeJsonAtomic(outputPath, report);
        throw new Error(
          `Codex V8 judge paused at ${caseId}/${dimension}; checkpoint saved`,
        );
      }
      report.cases[caseId] = saved;
      report.metrics = calibrationMetrics(Object.values(report.cases));
      writeJsonAtomic(outputPath, report);
      completedApplicableScores += 1;
      process.stdout.write(
        `CODEX_JUDGE_SCORE_COMPLETED=${caseId}/${dimension} SCORES=${completedApplicableScores}/${totalApplicableScores}\n`,
      );
    }
  }
  const complete = data.selected.every((item) =>
    applicableDimensions(item).every(
      (dimension) =>
        typeof report.cases[item.id]?.scores?.[dimension]?.score === 'number',
    ),
  );
  report.status = complete ? 'COMPLETE' : 'IN_PROGRESS';
  report.completedAt = complete ? new Date().toISOString() : null;
  report.metrics = calibrationMetrics(Object.values(report.cases));
  writeJsonAtomic(outputPath, report);
  process.stdout.write(
    JSON.stringify(
      {
        status: report.status,
        selectedCases: data.selected.length,
        processedCases: Object.keys(report.cases).length,
        judgeFingerprint,
        metrics: report.metrics,
        outputPath,
      },
      null,
      2,
    ) + '\n',
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });

module.exports = {
  indexedContext,
  selectCases,
  loadFrozenRun,
  promptFor,
  calibrationMetrics,
};
