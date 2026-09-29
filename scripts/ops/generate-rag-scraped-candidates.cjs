#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATASET_VERSION = 'rag-scraped-v1-provisional';
const TARGET_ROWS = 220;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const [name, inlineValue] = value.slice(2).split('=', 2);
    const next = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && next && !next.startsWith('--')) index += 1;
    args[name] = inlineValue ?? next;
  }
  return args;
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function compact(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function completeSentences(value) {
  const text = compact(value);
  if (!text) return [];
  const sentences = text.match(/[^.!?]+[.!?](?=\s|$)/g) ?? [];
  return sentences
    .map(compact)
    .filter((sentence) => sentence.split(/\s+/).length >= 4);
}

function firstCompleteSentence(value) {
  return completeSentences(value)[0] ?? '';
}

function shortText(value) {
  const text = compact(value);
  return text.length <= 220 ? text : `${text.slice(0, 219).trim()}…`;
}

function usefulDescription(value) {
  const text = firstCompleteSentence(value);
  if (!text || text.split(/\s+/).length < 10) return '';
  if (/^episode\s+\d+\s+of\s+.+:\s*.+\.?$/i.test(text)) return '';
  return text;
}

function earliestEvidence(items) {
  return [...items]
    .filter((item) => compact(item.evidenceText))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.startTime)
        ? left.startTime
        : Number.MAX_SAFE_INTEGER;
      const rightTime = Number.isFinite(right.startTime)
        ? right.startTime
        : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime || left.id.localeCompare(right.id);
    })[0];
}

function transcriptCandidate(reel, evidence) {
  const title = compact(reel.title) || 'this Reel';
  const sentences = completeSentences(evidence.evidenceText);
  const answer = sentences[0] || shortText(evidence.evidenceText);
  const causalAnswer = sentences.find((sentence) =>
    /\b(because|since|so that|therefore|due to)\b/i.test(sentence),
  );
  if (causalAnswer) {
    return {
      category: 'causal',
      question: `What reason is given in the early transcript of "${title}"?`,
      answer: causalAnswer,
    };
  }
  const temporalAnswer = sentences.find((sentence) =>
    /\b(before|after|then|later|first|next|while|when|during)\b/i.test(
      sentence,
    ),
  );
  if (temporalAnswer) {
    return {
      category: 'temporal',
      question: `What event is described as happening next or later in "${title}"?`,
      answer: temporalAnswer,
    };
  }
  const quantitativeAnswer = sentences.find((sentence) =>
    /\b\d+(?:\.\d+)?\b/.test(
      sentence.replace(/\b(?:episode|ep)\s*\d+\b/gi, ''),
    ),
  );
  if (quantitativeAnswer) {
    return {
      category: 'quantitative',
      question: `What number or quantity is mentioned in the early transcript of "${title}"?`,
      answer: quantitativeAnswer,
    };
  }
  return {
    category: 'transcript',
    question: `What is the opening statement in "${title}"?`,
    answer,
  };
}

function evidenceWindow(evidence) {
  return {
    referenceStartSec: Number.isFinite(evidence.startTime)
      ? evidence.startTime
      : null,
    referenceEndSec: Number.isFinite(evidence.endTime)
      ? evidence.endTime
      : null,
  };
}

function row({
  reel,
  evidence,
  category,
  question,
  answer,
  evidenceType,
  questionType,
}) {
  const sourceFingerprint = {
    reelId: reel.id,
    seriesId: reel.seriesId,
    title: reel.title ?? '',
    description: reel.description ?? '',
    tags: reel.tags ?? [],
    updatedAt: reel.updatedAt ?? null,
  };
  const indexFingerprint = {
    indexVersion: evidence.indexVersion,
    embeddingVersion: evidence.embeddingVersion,
    evidenceId: evidence.id,
    evidenceText: evidence.evidenceText,
    startTime: evidence.startTime ?? null,
    endTime: evidence.endTime ?? null,
  };
  return {
    id: `SCRAPED-CANDIDATE-${String(row.counter++).padStart(4, '0')}`,
    datasetVersion: DATASET_VERSION,
    question,
    referenceAnswer: answer,
    expectedIntent: 'REEL_VIDEO_QUESTION',
    expectedReferenceTarget: 'SHARED_REEL',
    expectedReelQuestionType: questionType,
    expectedEvidenceTypes: [evidenceType],
    expectedReelIds: [reel.id],
    relevantEvidenceIds: [evidence.id],
    accessScope: {
      policy: 'AUTHORIZED_CONTEXT_ONLY',
      authorizedReelIds: [reel.id],
    },
    tags: ['scraped-candidate', category, ...(reel.tags ?? []).slice(0, 5)],
    category,
    language: 'en',
    fixtureGroup: 'scraped-reel',
    metadata: {
      seriesId: reel.seriesId,
      annotationStatus: 'GENERATED_CANDIDATE',
      annotationSource: 'deterministic-index-evidence-template',
      sourceContentSha256: sha256(sourceFingerprint),
      indexSnapshotSha256: sha256(indexFingerprint),
      ...evidenceWindow(evidence),
      expectedConcepts: [],
    },
  };
}

row.counter = 1;

function generateCandidates(content, index) {
  row.counter = 1;
  const indexByReel = new Map(
    (index.reels ?? []).map((item) => [item.reelId, item]),
  );
  const reels = [...(content.reels ?? [])]
    .filter((reel) => indexByReel.has(reel.id))
    .sort((left, right) =>
      `${left.seriesId}:${left.id}`.localeCompare(
        `${right.seriesId}:${right.id}`,
      ),
    );

  const candidates = [];
  for (const [indexInCorpus, reel] of reels.entries()) {
    const evidence = indexByReel.get(reel.id);
    const transcript = earliestEvidence(evidence.chunks);
    const visual = earliestEvidence(evidence.visualScenes);
    const chosen =
      indexInCorpus % 2 === 0 ? (transcript ?? visual) : (visual ?? transcript);
    if (!chosen) continue;

    const title = compact(reel.title) || 'this Reel';
    const isVisual = chosen.kind === 'VISUAL';
    const transcriptQuestion = isVisual
      ? null
      : transcriptCandidate(reel, chosen);
    candidates.push(
      row({
        reel,
        evidence: chosen,
        category: isVisual ? 'visual' : transcriptQuestion.category,
        question: isVisual
          ? `What does the sampled visual scene from "${title}" show?`
          : transcriptQuestion.question,
        answer: isVisual
          ? firstCompleteSentence(chosen.evidenceText) ||
            shortText(chosen.evidenceText)
          : transcriptQuestion.answer,
        evidenceType: isVisual ? 'VISUAL' : 'TRANSCRIPT',
        questionType: isVisual ? 'VISUAL_CONTENT' : 'TRANSCRIPT_CONTENT',
      }),
    );
  }

  for (const [metadataIndex, reel] of reels
    .slice(0, Math.max(0, TARGET_ROWS - candidates.length))
    .entries()) {
    const evidence = indexByReel.get(reel.id).document;
    const title = compact(reel.title);
    if (!title || !evidence) continue;
    const description = usefulDescription(reel.description);
    const tags = (reel.tags ?? []).filter(Boolean);
    const metadataType = metadataIndex % 3;
    const metadataQuestion =
      metadataType === 0 && description && description.split(/\s+/).length >= 10
        ? {
            category: 'summary',
            question: `What is "${title}" about?`,
            answer: description,
          }
        : metadataType === 1 && tags.length
          ? {
              category: 'metadata',
              question: 'Which tags are associated with this Reel?',
              answer: tags.join(', '),
            }
          : {
              category: 'metadata',
              question: 'What title is assigned to this Reel?',
              answer: title,
            };
    candidates.push(
      row({
        reel,
        evidence: { ...evidence, kind: 'METADATA' },
        category: metadataQuestion.category,
        question: metadataQuestion.question,
        answer: metadataQuestion.answer,
        evidenceType: 'METADATA',
        questionType: 'REEL_METADATA',
      }),
    );
    if (candidates.length >= TARGET_ROWS) break;
  }

  return candidates.slice(0, TARGET_ROWS);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.content || !args.index || !args.output) {
    throw new Error(
      'Usage: generate-rag-scraped-candidates --content <json> --index <json> --output <jsonl>',
    );
  }
  const content = JSON.parse(
    fs.readFileSync(path.resolve(args.content), 'utf8'),
  );
  const index = JSON.parse(fs.readFileSync(path.resolve(args.index), 'utf8'));
  const candidates = generateCandidates(content, index);
  if (candidates.length < 100) {
    throw new Error(
      `indexed corpus produced only ${candidates.length} candidates; need at least 100`,
    );
  }
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(
    output,
    `${candidates.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`,
    'utf8',
  );
  process.stdout.write(
    `${JSON.stringify({ datasetVersion: DATASET_VERSION, candidateRows: candidates.length, output }, null, 2)}\n`,
  );
}

if (require.main === module) main();

module.exports = { generateCandidates };
