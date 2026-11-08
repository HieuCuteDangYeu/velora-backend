#!/usr/bin/env node
'use strict';

// Scores alternative wordings of the fixed refusal and denial answers on the benchmark cases that use them, with the
// shared Haiku prompt builder (response relevancy). Usage:
//   judge-refusal-wordings.cjs <responses.jsonl> <dataset-dir> <out.jsonl> [--shard I/K] [--samples N]

const fs = require('node:fs');
const path = require('node:path');
const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
const { runClaudeDimension } = require('./run-claude-rag-judge.cjs');

const MEMORY_TAIL =
  'I can only search your own saved memory, and I do not have the requested detail available here.';
const GROUPS = {
  audio: {
    match: (answer) => /does not contain enough audio evidence/.test(answer),
    wordings: {
      current:
        'The available shared Reel context does not contain enough audio evidence to identify the requested audio detail. I can help with the other parts of this Reel that are available.',
      explain:
        'I can’t identify that sound: the indexed audio for this Reel captures what is said, not background sounds or effects, so I would only be guessing. I can summarize what is said around that moment or describe what is visible in the nearest frame instead.',
      short:
        'I don’t have indexed audio evidence for that sound, so I won’t guess. Ask me about what is said or shown around that moment and I can answer from the transcript or frames.',
    },
  },
  visual: {
    match: (answer) => /does not contain enough visual evidence/.test(answer),
    wordings: {
      current:
        'The available shared Reel context does not contain enough visual evidence to identify the requested visual detail. I can help with the other parts of this Reel that are available.',
      explain:
        'I can’t confirm that visual detail: the indexed frame analysis for this Reel does not show it, so I would only be guessing. I can describe what the indexed frames do show or summarize what is said at that point instead.',
      short:
        'I don’t have indexed visual evidence for that detail, so I won’t guess. I can describe what the indexed frames do show, or what is said around that moment.',
      safe: 'I don’t have indexed visual evidence for that detail, so I won’t guess. I can help with the other parts of this Reel that are available, such as what is said around that moment.',
    },
  },
  memory: {
    match: (answer) => answer.startsWith(MEMORY_TAIL),
    wordings: {
      current: `${MEMORY_TAIL} If you tell me the detail in this chat I can work from it, or you can ask the other person directly.`,
      explain:
        'I can only search your own saved memory, so I can’t look up another person’s details, and I have nothing saved that answers this. If it is about someone else, you can ask them directly; if it is yours, tell me here and I can work from it.',
      short:
        'I can’t share another person’s saved memory, and I have nothing saved from you that answers this. You can ask them directly, or tell me the detail here and I will use it.',
    },
  },
};

function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const [shardIndex, shardCount] = flag('--shard', '0/1')
    .split('/')
    .map(Number);
  const samples = Number(flag('--samples', '2'));
  const [responsesPath, datasetDir, outPath] = args;
  const rows = new Map();
  for (const split of ['development', 'held_out'])
    for (const row of JSON.parse(
      fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
    ))
      rows.set(row.id, row);
  const jobs = [];
  for (const line of fs
    .readFileSync(responsesPath, 'utf8')
    .split('\n')
    .filter(Boolean)) {
    const record = JSON.parse(line);
    const answer = String(record.output?.answer ?? '');
    for (const [group, spec] of Object.entries(GROUPS))
      if (spec.match(answer))
        for (const wording of Object.keys(spec.wordings).filter(
          (name) =>
            !process.env.ONLY_WORDING ||
            name === process.env.ONLY_WORDING ||
            name === 'current',
        ))
          for (let sample = 0; sample < samples; sample += 1)
            jobs.push({ id: record.caseId, group, wording, sample });
  }
  const done = new Set(
    fs.existsSync(outPath)
      ? fs
          .readFileSync(outPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .map((r) => `${r.id}|${r.wording}|${r.sample}`)
      : [],
  );
  jobs
    .filter((_, position) => position % shardCount === shardIndex)
    .forEach((job) => {
      if (done.has(`${job.id}|${job.wording}|${job.sample}`)) return;
      const row = rows.get(job.id);
      const score = runClaudeDimension(
        'responseRelevancy',
        buildDimensionPrompt('responseRelevancy', {
          question: row.input.question,
          generatedAnswer: GROUPS[job.group].wordings[job.wording],
          referenceAnswer: row.expectedOutput.referenceAnswer,
          answerType: row.metadata.answerType,
          policyAssertions: row.expectedOutput.assertions,
          expectedEvidenceTypes: row.expectedOutput.expectedEvidenceTypes,
        }),
      ).score;
      fs.appendFileSync(outPath, `${JSON.stringify({ ...job, score })}\n`);
    });
}

main();
