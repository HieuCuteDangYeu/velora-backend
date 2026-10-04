#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { PrismaClient: ContentPrismaClient } = require('@prisma/content-client');
const {
  PrismaClient: ReelIndexingPrismaClient,
} = require('@prisma/reel-indexing-client');

const EXISTING_AMI_REELS = [
  {
    meetingId: 'IN1001',
    fixtureId: 'ami-in1001-75-150',
    reelId: '9f5ed300-8b47-4715-a23f-d5082987ff43',
    referenceFile: 'ami-in1001-75-150.json',
  },
  {
    meetingId: 'IN1002',
    fixtureId: 'ami-IN1002-short-001',
    reelId: 'f9f57d92-7edf-4cc7-993a-24302bc3858b',
    referenceFile: 'ami-IN1002-short-001.json',
  },
  {
    meetingId: 'IN1005',
    fixtureId: 'ami-IN1005-short-001',
    reelId: '944c9e59-cc47-412c-aece-f378cf758d66',
    referenceFile: 'ami-IN1005-short-001.json',
  },
  {
    meetingId: 'IN1007',
    fixtureId: 'ami-IN1007-short-001',
    reelId: '487ebc29-697c-406c-8990-6d7a264c2c3c',
    referenceFile: 'ami-IN1007-short-001.json',
  },
];

const IN1001_QUESTIONS = [
  {
    question: 'Who is the video shot detector being presented to?',
    referenceAnswerText: 'Olivier.',
    referenceStartSec: 42,
    referenceEndSec: 57,
    expectedConcepts: ['Olivier', 'video shot detector'],
  },
  {
    question:
      'Where was the video shot detector project carried out, and under whose supervision?',
    referenceAnswerText: 'During an internship at IDIAP under Jean-Marc.',
    referenceStartSec: 60,
    referenceEndSec: 75,
    expectedConcepts: ['IDIAP', 'Jean-Marc', 'internship'],
  },
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value || value === '--' || !value.startsWith('--')) continue;
    const [name, inlineValue] = value.slice(2).split('=', 2);
    const nextValue = argv[index + 1];
    if (inlineValue === undefined && nextValue && !nextValue.startsWith('--')) {
      args[name] = nextValue;
      index += 1;
    } else {
      args[name] = inlineValue ?? 'true';
    }
  }
  return args;
}

function runId() {
  return `existing-reels-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function csv(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[\",\n]/.test(text) ? `\"${text.replace(/\"/g, '\"\"')}\"` : text;
}

function readReferenceQuestions(datasetDir, reel) {
  if (reel.meetingId === 'IN1001') return IN1001_QUESTIONS;
  const file = path.join(datasetDir, 'reference', reel.referenceFile);
  const reference = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(reference.questions) ? reference.questions : [];
}

function isoTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

function toReportRow(reel, content, counts, questions) {
  return {
    ...reel,
    found: Boolean(content),
    status: content?.status ?? null,
    mediaStatus: content?.mediaStatus ?? null,
    indexStatus: content?.indexStatus ?? null,
    processingStage: content?.processingStage ?? null,
    sourceLengthClass: content?.sourceLengthClass ?? null,
    indexVersion: content?.indexVersion ?? null,
    indexCompletedAt: isoTimestamp(content?.indexCompletedAt),
    contentIndexChunkCount: content?.indexChunkCount ?? null,
    activeDocumentCount: counts.documents ?? 0,
    activeSectionCount: counts.sections ?? 0,
    activeChunkCount: counts.chunks ?? 0,
    activeVisualSceneCount: counts.visualScenes ?? 0,
    questions,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true' || args.h === 'true') {
    console.log(
      'Usage: node scripts/ops/refresh-existing-integration-reels.cjs --env-file=.env.test.local [--dataset-dir=test-data/reel-integration/ami] [--run-id=...] [--state-file=/path/to/read-only-snapshot.json]',
    );
    return;
  }

  const envFile = path.resolve(args['env-file'] || '.env.test.local');
  dotenv.config({ path: envFile, override: true });
  const datasetDir = path.resolve(
    args['dataset-dir'] || 'test-data/reel-integration/ami',
  );
  const reportId = args['run-id'] || runId();
  const reportDirectory = path.join(datasetDir, 'reports');
  const reelIds = EXISTING_AMI_REELS.map((reel) => reel.reelId);
  const stateFile = args['state-file']
    ? path.resolve(args['state-file'])
    : null;
  const content = stateFile ? null : new ContentPrismaClient();
  const indexing = stateFile ? null : new ReelIndexingPrismaClient();

  try {
    const snapshot = stateFile
      ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      : await (async () => {
          const [reels, documents, sections, chunks, visualScenes] =
            await Promise.all([
              content.reel.findMany({
                where: { id: { in: reelIds } },
                select: {
                  id: true,
                  status: true,
                  mediaStatus: true,
                  indexStatus: true,
                  processingStage: true,
                  sourceLengthClass: true,
                  indexVersion: true,
                  indexCompletedAt: true,
                  indexChunkCount: true,
                },
              }),
              indexing.reelDocument.groupBy({
                by: ['reelId'],
                where: { reelId: { in: reelIds }, isActive: true },
                _count: { _all: true },
              }),
              indexing.reelSection.groupBy({
                by: ['reelId'],
                where: { reelId: { in: reelIds }, isActive: true },
                _count: { _all: true },
              }),
              indexing.reelChunk.groupBy({
                by: ['reelId'],
                where: { reelId: { in: reelIds }, isActive: true },
                _count: { _all: true },
              }),
              indexing.reelVisualScene.groupBy({
                by: ['reelId'],
                where: { reelId: { in: reelIds }, isActive: true },
                _count: { _all: true },
              }),
            ]);
          return { reels, documents, sections, chunks, visualScenes };
        })();
    const { reels, documents, sections, chunks, visualScenes } = snapshot;
    if (
      ![reels, documents, sections, chunks, visualScenes].every(Array.isArray)
    ) {
      throw new Error(
        'State snapshot must contain reels, documents, sections, chunks, and visualScenes arrays.',
      );
    }

    const byReelId = new Map(reels.map((reel) => [reel.id, reel]));
    const countMap = (rows) =>
      new Map(rows.map((row) => [row.reelId, row._count._all]));
    const documentCounts = countMap(documents);
    const sectionCounts = countMap(sections);
    const chunkCounts = countMap(chunks);
    const visualSceneCounts = countMap(visualScenes);
    const rows = EXISTING_AMI_REELS.map((reel) =>
      toReportRow(
        reel,
        byReelId.get(reel.reelId),
        {
          documents: documentCounts.get(reel.reelId),
          sections: sectionCounts.get(reel.reelId),
          chunks: chunkCounts.get(reel.reelId),
          visualScenes: visualSceneCounts.get(reel.reelId),
        },
        readReferenceQuestions(datasetDir, reel),
      ),
    );
    const ready = rows.filter(
      (row) =>
        row.found &&
        row.status === 'COMPLETED' &&
        row.mediaStatus === 'COMPLETED' &&
        row.indexStatus === 'COMPLETED',
    );
    const benchmarkCases = rows.flatMap((row) =>
      row.questions.map((question, index) => ({
        caseId: `${row.meetingId}-${index + 1}`,
        meetingId: row.meetingId,
        fixtureId: row.fixtureId,
        reelId: row.reelId,
        question: question.question,
        expectedEvidenceType: question.expectedEvidenceType ?? 'TRANSCRIPT',
        referenceAnswerText: question.referenceAnswerText,
        referenceStartSec: question.referenceStartSec,
        referenceEndSec: question.referenceEndSec,
        expectedConcepts: question.expectedConcepts ?? [],
        status: 'NOT_EVALUATED',
      })),
    );
    const report = {
      runId: reportId,
      generatedAt: new Date().toISOString(),
      mode: 'refresh-existing-integration-reels',
      readOnly: true,
      stateSource: stateFile
        ? 'verified-read-only-snapshot'
        : 'direct-database-read',
      mutationGuarantees: [
        'No media upload or reel creation.',
        'No job enqueue or database write.',
        'Only SELECT/groupBy reads are issued to Content and Reel Indexing databases.',
      ],
      summary: {
        expectedReels: rows.length,
        foundReels: rows.filter((row) => row.found).length,
        sourceReadyReels: ready.length,
      },
      reels: rows,
      ragBenchmark: {
        status: 'NOT_EVALUATED',
        exactCaseCount: benchmarkCases.length,
        reason:
          'The production chat workflow persists conversation records and emits Langfuse traces. Skipped because this refresh is explicitly read-only and must not mutate the database.',
        cases: benchmarkCases,
      },
    };

    fs.mkdirSync(reportDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(reportDirectory, `${reportId}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    const columns = [
      'meetingId',
      'fixtureId',
      'reelId',
      'found',
      'status',
      'mediaStatus',
      'indexStatus',
      'activeDocumentCount',
      'activeSectionCount',
      'activeChunkCount',
      'activeVisualSceneCount',
    ];
    fs.writeFileSync(
      path.join(reportDirectory, `${reportId}.csv`),
      [
        columns.join(','),
        ...rows.map((row) => columns.map((key) => csv(row[key])).join(',')),
      ].join('\n'),
      'utf8',
    );
    console.log(
      JSON.stringify(
        {
          reportId,
          reportDirectory,
          summary: report.summary,
          ragBenchmark: report.ragBenchmark,
        },
        null,
        2,
      ),
    );
    if (report.summary.sourceReadyReels !== EXISTING_AMI_REELS.length)
      process.exitCode = 1;
  } finally {
    await Promise.allSettled(
      [content, indexing].filter(Boolean).map((client) => client.$disconnect()),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
