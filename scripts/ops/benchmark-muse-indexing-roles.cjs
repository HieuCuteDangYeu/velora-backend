#!/usr/bin/env node
'use strict';
// Offline A/B of the indexing text roles: the production Ollama model (baseline) against the local muse2api gateway (muse).
// Runs the real use cases (ExtractReelMetadata, ReviewIndexQuality, TranslateSubtitleCues) on public AMI meeting transcripts,
// so no user content is sent to Meta. Writes <out>/raw.json and prints a summary. Never touches production data.
// Usage (repo root): node scripts/ops/benchmark-muse-indexing-roles.cjs <outDir> [--n=24] [--roles=metadata,quality,translation]
//   [--baseline-model=gemma4:e2b-it-qat] [--ollama-url=http://127.0.0.1:11434] [--judge]
// --mode=load [--levels=1,2,4,8] [--per-level=16] sweeps concurrency on the metadata role for the muse and baseline60 arms and reports
// throughput, latency percentiles and error rate instead of running the quality benchmark.
// --judge adds a pairwise Haiku judge (claude CLI) for metadata and translation quality.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
require('ts-node').register({
  transpileOnly: true,
  project: path.join(ROOT, 'tsconfig.json'),
});
require('tsconfig-paths/register');
require('reflect-metadata');
require('@nestjs/common').Logger.overrideLogger(false);

const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);
const outDir = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!outDir) throw new Error('usage: benchmark-muse-indexing-roles <outDir>');
const N = Number(flags.n ?? 24);
// --source=vi runs the roles on synthetic Vietnamese short-video transcripts (muse-vi-passages.json): no user content.
const VI = flags.source === 'vi';
const ROLES = (flags.roles ?? 'metadata,quality,translation').split(',');
const ARMS = ['baseline', 'baseline60', 'muse'];
const BASELINE_MODEL = flags['baseline-model'] ?? 'gemma4:e2b-it-qat';
const AMI = path.join(process.env.HOME, 'ami_data/source/annotations');

// ---- deterministic AMI windows -------------------------------------------------------------------------------------
function seeded(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
function meetingWords(meeting) {
  const dir = path.join(AMI, 'words');
  const words = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.startsWith(`${meeting}.`))) {
    const xml = fs.readFileSync(path.join(dir, f), 'latin1');
    for (const m of xml.matchAll(
      /<w [^>]*?starttime="([\d.]+)"[^>]*?>([^<]*)<\/w>/g,
    )) {
      const isPunc = /punc="true"/.test(m[0]);
      words.push({
        t: Number(m[1]),
        text: m[2]
          .replace(/&#39;|&apos;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .trim(),
        punc: isPunc,
      });
    }
  }
  return words.sort((a, b) => a.t - b.t);
}
function buildWindows(n) {
  const meetings = [
    ...new Set(
      fs.readdirSync(path.join(AMI, 'words')).map((f) => f.split('.')[0]),
    ),
  ].sort();
  const rnd = seeded(20261117);
  const order = meetings
    .map((m) => [rnd(), m])
    .sort((a, b) => a[0] - b[0])
    .map((x) => x[1]);
  const windows = [];
  for (const meeting of order) {
    if (windows.length >= n) break;
    const words = meetingWords(meeting);
    if (words.length < 600) continue;
    const start = words[Math.floor(words.length * (0.2 + 0.5 * rnd()))].t;
    const slice = words.filter((w) => w.t >= start && w.t < start + 100);
    if (slice.length < 180) continue;
    let text = '';
    for (const w of slice) text += w.punc ? w.text : ` ${w.text}`;
    windows.push({
      id: `${meeting}@${Math.round(start)}`,
      transcript: text.trim(),
      durationMs: 100_000,
    });
  }
  return windows;
}
function cuesFrom(transcript) {
  const w = transcript.split(/\s+/);
  const cues = [];
  for (let i = 0, k = 0; i < w.length && cues.length < 20; i += 11, k += 1)
    cues.push({ index: k, text: w.slice(i, i + 11).join(' ') });
  return cues;
}

// ---- real use cases wired to either provider ----------------------------------------------------------------------
function build() {
  const { ConfigService } = require('@nestjs/config');
  const values = {
    OLLAMA_BASE_URL: flags['ollama-url'] ?? 'http://127.0.0.1:11434',
    AI_METADATA_EXTRACTION_MODEL: BASELINE_MODEL,
    AI_INDEX_QUALITY_MODEL: BASELINE_MODEL,
    AI_SUBTITLE_TRANSLATION_MODEL: BASELINE_MODEL,
    AI_ANSWER_MODEL: BASELINE_MODEL,
    MUSE_BASE_URL: process.env.MUSE_BASE_URL,
    MUSE_API_KEY: process.env.MUSE_API_KEY,
    MUSE_MODEL: process.env.MUSE_MODEL,
  };
  const config = new ConfigService();
  config.get = (key) => values[key];
  const {
    AiApplicationConfigAdapter,
  } = require('@ai/infrastructure/adapters/ai-application-config.adapter');
  const {
    OllamaTextClient,
  } = require('@ai/infrastructure/adapters/ollama-text.client');
  const {
    OllamaStructuredLlmAdapter,
  } = require('@ai/infrastructure/adapters/ollama-structured-llm.adapter');
  const {
    MuseStructuredLlmAdapter,
  } = require('@ai/infrastructure/adapters/muse-structured-llm.adapter');
  const {
    ExtractReelMetadataUseCase,
  } = require('@ai/application/use-cases/extract-reel-metadata.use-case');
  const {
    ReviewIndexQualityUseCase,
  } = require('@ai/application/use-cases/review-index-quality.use-case');
  const {
    TranslateSubtitleCuesUseCase,
  } = require('@ai/application/use-cases/translate-subtitle-cues.use-case');
  const appConfig = new AiApplicationConfigAdapter(config);
  const ollama = new OllamaStructuredLlmAdapter(
    new OllamaTextClient(config),
    config,
  );
  // baseline runs with the production per-role timeouts (8s for metadata and quality); baseline60 relaxes them to 60s so the
  // model's quality can be compared with Muse even where production would have timed out.
  const relaxed = Object.create(appConfig);
  relaxed.timeoutMs = () => 60_000;
  const arms = {
    baseline: [ollama, appConfig],
    baseline60: [ollama, relaxed],
    muse: [new MuseStructuredLlmAdapter(config), appConfig],
  };
  return Object.fromEntries(
    Object.entries(arms).map(([name, [llm, cfg]]) => [
      name,
      {
        metadata: new ExtractReelMetadataUseCase(llm, cfg),
        quality: new ReviewIndexQualityUseCase(llm, cfg),
        translation: new TranslateSubtitleCuesUseCase(llm, cfg),
      },
    ]),
  );
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    return { ok: true, value: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      error: `${e.code ?? e.name}: ${String(e.message).slice(0, 120)}`,
      ms: Date.now() - t0,
    };
  }
}

function qualityInput(window, metadata, tag) {
  return {
    reelId: `bench-${window.id}-${tag}`,
    sourceLengthClass: 'SHORT',
    durationMs: window.durationMs,
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags ?? [],
    documents: [
      {
        id: 'doc-reel',
        kind: 'REEL',
        ordinal: 0,
        evidenceQuality: 'VERIFIED',
        text: [metadata.title, metadata.description].filter(Boolean).join('\n'),
      },
      {
        id: 'doc-chunk-0',
        kind: 'CHUNK',
        ordinal: 0,
        parentId: 'doc-reel',
        startTime: 0,
        endTime: window.durationMs,
        evidenceQuality: 'VERIFIED',
        text: window.transcript,
      },
    ],
  };
}

async function loadTest(arms, windows) {
  const levels = (flags.levels ?? '1,2,4,8').split(',').map(Number);
  const perLevel = Number(flags['per-level'] ?? 16);
  const report = [];
  for (const arm of ['muse', 'baseline60']) {
    for (const level of levels) {
      const results = [];
      let next = 0;
      const t0 = Date.now();
      await Promise.all(
        Array.from({ length: level }, async () => {
          while (next < perLevel) {
            const w = windows[next++ % windows.length];
            results.push(
              await timed(() =>
                arms[arm].metadata.execute({
                  transcript: w.transcript,
                  tags: [],
                  maxTags: 8,
                }),
              ),
            );
          }
        }),
      );
      const wallMs = Date.now() - t0;
      const ok = results
        .filter((r) => r.ok)
        .map((r) => r.ms)
        .sort((a, b) => a - b);
      const row = {
        arm,
        concurrency: level,
        requests: results.length,
        errorRate: 1 - ok.length / results.length,
        throughputPerMin: +((results.length / wallMs) * 60_000).toFixed(1),
        okPerMin: +((ok.length / wallMs) * 60_000).toFixed(1),
        p50Ms: ok[Math.floor(ok.length * 0.5)],
        p95Ms: ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.95))],
      };
      report.push(row);
      console.log(JSON.stringify(row));
    }
  }
  fs.writeFileSync(
    path.join(outDir, 'load.json'),
    JSON.stringify(report, null, 2),
  );
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const windows = VI
    ? JSON.parse(
        fs.readFileSync(path.join(__dirname, 'muse-vi-passages.json'), 'utf8'),
      ).slice(0, N)
    : buildWindows(N);
  if (flags.mode === 'load') return loadTest(build(), windows);
  console.log(
    `${windows.length} AMI windows; baseline=${BASELINE_MODEL}; roles=${ROLES.join(',')}`,
  );
  const arms = build();
  const raw = {
    windows: windows.map((w) => w.id),
    metadata: {},
    quality: {},
    translation: {},
  };

  // metadata first: the quality role reviews metadata that matches (should pass) or comes from another window (should fail)
  const runArm = async (arm) => {
    const uc = arms[arm];
    raw.metadata[arm] = [];
    raw.translation[arm] = [];
    raw.quality[arm] = [];
    for (let i = 0; i < windows.length; i += 1) {
      const w = windows[i];
      if (ROLES.includes('metadata'))
        raw.metadata[arm].push({
          id: w.id,
          ...(await timed(() =>
            uc.metadata.execute({
              transcript: w.transcript,
              tags: [],
              maxTags: 8,
            }),
          )),
        });
      if (ROLES.includes('translation'))
        raw.translation[arm].push({
          id: w.id,
          cues: cuesFrom(w.transcript),
          ...(await timed(() =>
            uc.translation.execute({
              sourceLanguage: VI ? 'vi' : 'en',
              targetLanguage: VI ? 'en' : 'vi',
              cues: cuesFrom(w.transcript),
            }),
          )),
        });
      process.stderr.write(`\r${arm} ${i + 1}/${windows.length}`);
    }
    process.stderr.write('\n');
  };
  // Muse runs beside Ollama; the two Ollama arms run one after the other so they do not slow each other down.
  await Promise.all([
    (async () => {
      await runArm('baseline');
      await runArm('baseline60');
    })(),
    runArm('muse'),
  ]);

  if (ROLES.includes('quality')) {
    // Reference metadata comes from the Muse arm's own output when present, else the baseline's: both arms review identical inputs.
    const metaFor = (i) => {
      const pick = [raw.metadata.muse[i], raw.metadata.baseline60[i]].find(
        (r) => r?.ok,
      );
      return pick?.value;
    };
    const cases = [];
    windows.forEach((w, i) => {
      const own = metaFor(i);
      const other = metaFor((i + 7) % windows.length);
      if (own)
        cases.push({
          id: `${w.id}:matched`,
          expect: true,
          input: qualityInput(w, own, 'ok'),
        });
      if (own && other)
        cases.push({
          id: `${w.id}:mismatched`,
          expect: false,
          input: qualityInput(w, other, 'bad'),
        });
    });
    raw.quality.cases = cases.map((c) => ({ id: c.id, expect: c.expect }));
    const runQuality = async (arm) => {
      raw.quality[arm] = [];
      for (const c of cases)
        raw.quality[arm].push({
          id: c.id,
          expect: c.expect,
          ...(await timed(() => arms[arm].quality.execute(c.input))),
        });
    };
    await Promise.all([
      (async () => {
        await runQuality('baseline');
        await runQuality('baseline60');
      })(),
      runQuality('muse'),
    ]);
  }

  if (flags.judge) await judgePairs(raw, windows);
  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(raw, null, 2));
  summarize(raw);
}

// ---- pairwise Haiku judge -------------------------------------------------------------------------------------------
function haiku(prompt) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['winner', 'reason'],
    properties: {
      winner: { type: 'string', enum: ['A', 'B', 'TIE'] },
      reason: { type: 'string', maxLength: 300 },
    },
  };
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--model',
      'claude-haiku-5-5',
      '--tools',
      '',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: 'dumb',
        NO_COLOR: '1',
      },
      input: prompt,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  try {
    return JSON.parse(run.stdout).structured_output;
  } catch {
    return undefined;
  }
}
async function judgePairs(raw, windows) {
  raw.judge = { metadata: [], translation: [] };
  const rnd = seeded(7);
  const decide = (task, aOut, bOut, context) => {
    const swap = rnd() < 0.5;
    const [A, B] = swap ? [bOut, aOut] : [aOut, bOut];
    const verdict = haiku(
      `${task}\n\nSource:\n${context}\n\nCandidate A:\n${JSON.stringify(A)}\n\nCandidate B:\n${JSON.stringify(B)}\n\nWhich candidate is better? Judge accuracy to the source, usefulness and fluency. Answer TIE only if they are equivalent.`,
    );
    if (!verdict) return undefined;
    const w =
      verdict.winner === 'TIE'
        ? 'tie'
        : (verdict.winner === 'A') === !swap
          ? 'muse'
          : 'baseline';
    return { winner: w, reason: verdict.reason };
  };
  // a = muse output, b = baseline output
  for (let i = 0; i < windows.length; i += 1) {
    const m = raw.metadata.muse?.[i],
      b = raw.metadata.baseline60?.[i];
    if (m?.ok && b?.ok)
      raw.judge.metadata.push({
        id: windows[i].id,
        ...decide(
          'Compare two title/description/tag sets for a short video, generated from its transcript. Prefer accurate, specific, searchable metadata that invents nothing.',
          m.value,
          b.value,
          windows[i].transcript,
        ),
      });
    const tm = raw.translation.muse?.[i],
      tb = raw.translation.baseline60?.[i];
    if (tm?.ok && tb?.ok)
      raw.judge.translation.push({
        id: windows[i].id,
        ...decide(
          VI
            ? 'Compare two English translations of Vietnamese subtitle lines. Prefer faithful, natural English that keeps every line.'
            : 'Compare two Vietnamese translations of English subtitle lines. Prefer faithful, natural Vietnamese that keeps every line.',
          tm.value.cues,
          tb.value.cues,
          JSON.stringify(tm.cues),
        ),
      });
    process.stderr.write(`\rjudge ${i + 1}/${windows.length}`);
  }
  process.stderr.write('\n');
}

// ---- summary --------------------------------------------------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(0)}%`;
const median = (xs) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN;
function summarize(raw) {
  const lines = [];
  for (const role of ['metadata', 'translation', 'quality']) {
    if (!raw[role].muse?.length) continue;
    for (const arm of ARMS) {
      const rows = raw[role][arm];
      const ok = rows.filter((r) => r.ok);
      let extra = '';
      if (role === 'metadata') {
        const tags = ok.reduce(
          (sum, r) => sum + (r.value.tags?.length ?? 0),
          0,
        );
        extra = ` avgTags=${(tags / Math.max(1, ok.length)).toFixed(1)}`;
      }
      if (role === 'translation') {
        const viChars = ok.map(
          (r) =>
            (
              r.value.cues
                .map((c) => c.text)
                .join('')
                .match(
                  /[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi,
                ) ?? []
            ).length,
        );
        extra = ` avgDiacritics=${(viChars.reduce((a, b) => a + b, 0) / Math.max(1, ok.length)).toFixed(0)}`;
      }
      if (role === 'quality') {
        const matched = ok.filter((r) => r.expect),
          bad = ok.filter((r) => !r.expect);
        extra = ` acceptsMatched=${pct(matched.filter((r) => r.value.acceptable).length / Math.max(1, matched.length))} rejectsMismatched=${pct(bad.filter((r) => !r.value.acceptable).length / Math.max(1, bad.length))}`;
      }
      lines.push(
        `${role.padEnd(11)} ${arm.padEnd(8)} success=${ok.length}/${rows.length} (${pct(ok.length / Math.max(1, rows.length))}) medianMs=${median(ok.map((r) => r.ms))} p95Ms=${[...ok.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(ok.length * 0.95)] ?? NaN}${extra}`,
      );
      const errs = {};
      rows
        .filter((r) => !r.ok)
        .forEach(
          (r) =>
            (errs[r.error.split(':')[0]] =
              (errs[r.error.split(':')[0]] ?? 0) + 1),
        );
      if (Object.keys(errs).length)
        lines.push(`             errors ${JSON.stringify(errs)}`);
    }
  }
  if (raw.judge)
    for (const role of ['metadata', 'translation']) {
      const j = raw.judge[role].filter((x) => x.winner);
      const c = (w) => j.filter((x) => x.winner === w).length;
      lines.push(
        `judge ${role}: muse ${c('muse')} / baseline ${c('baseline')} / tie ${c('tie')} (n=${j.length})`,
      );
    }
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
