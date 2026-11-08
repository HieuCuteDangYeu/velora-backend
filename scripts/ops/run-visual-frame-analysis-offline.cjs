#!/usr/bin/env node
// Offline re-analysis of locally stored reviewed frames with the production Cloudflare vision call (control) or a tightened prompt (tight).
// Usage (from repo root): node scripts/ops/run-visual-frame-analysis-offline.cjs <control|tight|concise> <out.jsonl> [limit] [--provider=claude|groq|ollama]
// --provider=ollama uses a local Ollama vision model (OLLAMA_VISION_MODEL, default gemma4:e4b-it-qat) at OLLAMA_BASE_URL or 127.0.0.1:11434.
// --provider=groq uses a Groq vision model (GROQ_VISION_MODEL, default qwen/qwen3.8-27b) rotating through GROQ_API_KEYS.
// concise = tight plus a caption of at most 30 words and at most 6 objects, to test whether verbosity is penalised against terse references.
// --provider=claude uses Claude Haiku 5.5 via the claude CLI as the vision model: a stronger model than production's, so it
// measures a prompt change or a better-vision-model ceiling, not production behaviour. Default is the production Cloudflare model.
// Resumable (skips analysed cases), stops cleanly on a 429, never writes to production data.
const fs = require('fs'),
  path = require('path');
const ROOT = process.cwd();
require(ROOT + '/node_modules/dotenv').config({
  path: path.join(ROOT, '.env'),
  quiet: true,
});
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const provider =
  (process.argv.find((a) => a.startsWith('--provider=')) || '').split('=')[1] ||
  'cloudflare';
const [variant, outFile, limitArg] = args;
if (!['control', 'tight', 'concise'].includes(variant) || !outFile)
  throw new Error(
    'usage: vision-run <control|tight|concise> <out.jsonl> [limit] [--provider=claude]',
  );
const PK =
  ROOT +
  '/.benchmarks/rag-remediation-v8-20261027-01/visual-frame-review-complete-20261027-01/review-packet-v2-dataset-bound.json';
const FRAMES =
  ROOT +
  '/.benchmarks/rag-remediation-v7-20261022-01/visual-frame-review-complete-20261027-02/frames/';
const packet = JSON.parse(fs.readFileSync(PK));
const items = [];
const seen = new Set();
for (const r of packet.frameReviews) {
  const g = (r.expectedEvidenceGroups || []).flat()[0] || '';
  const m = g.match(/^reel:([0-9a-f-]+):visual:(\d+)$/);
  if (!m) continue;
  const file = `${m[1]}-visual-${m[2]}.jpg`;
  if (!fs.existsSync(FRAMES + file) || seen.has(file)) continue;
  seen.add(file);
  items.push({ caseId: r.caseId, file });
}
const limit = limitArg ? Number(limitArg) : items.length;
const done = new Set(
  fs.existsSync(outFile)
    ? fs
        .readFileSync(outFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).caseId)
    : [],
);
const SYS_BASE =
  'Analyze only the supplied single frame. Do not infer speech, identity, intent, emotion, motion, hidden text, or events outside this sampled timestamp. Return only a JSON object with exactly these keys: caption (a non-empty factual string), ocrText (a string containing only clearly readable text and empty when it cannot be read), and objects (an array of short grounded strings). When multiple people are visible, prefix person-specific observations with a stable label such as "subject 1:" or "subject 2:"; use "unassigned:" when an attribute cannot be linked to one subject. Never turn an unassigned attribute into a claim about every person.';
const USER_BASE =
  'Set caption to a factual description of visible content, ocrText to only clearly readable text, and objects to important visible objects or UI elements. Preserve visible numbers and code exactly; omit uncertain text. Do not say that no text exists merely because OCR is empty.';
const SYS_TIGHT =
  SYS_BASE +
  " Describe a person's pose or action only when it is unambiguous in this frame, using plain posture words such as standing, sitting or leaning. Name an object, prop, tool or weapon only when it is clearly visible; never add items that are merely plausible for the scene. Put exact on-screen text, copied character for character, in ocrText and nothing else; omit any word you cannot read with certainty. Never put object names or descriptive words into ocrText.";
const USER_TIGHT =
  USER_BASE +
  ' Keep the caption to what is plainly visible: people, their clothing, their pose, the setting and the lighting. List objects only if clearly visible.';
const SYS_CONCISE =
  SYS_TIGHT +
  ' Write caption as one or two plain sentences of at most 30 words in total, like short alt text. List at most 6 objects, each one or two words.';
const sys =
    variant === 'control'
      ? SYS_BASE
      : variant === 'tight'
        ? SYS_TIGHT
        : SYS_CONCISE,
  usr = variant === 'control' ? USER_BASE : USER_TIGHT;
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
const headers = {
  Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
  'Content-Type': 'application/json',
  'cf-aig-skip-cache': 'true',
};
if ((process.env.CLOUDFLARE_AI_GATEWAY_ENABLED ?? 'true') !== 'false')
  headers['cf-aig-gateway-id'] = process.env.CLOUDFLARE_AI_GATEWAY_ID;
function analyzeWithClaude(file) {
  const { spawnSync } = require('node:child_process');
  const framePath = FRAMES + file;
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['caption', 'ocrText', 'objects'],
    properties: {
      caption: { type: 'string' },
      ocrText: { type: 'string' },
      objects: { type: 'array', items: { type: 'string' } },
    },
  };
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--model',
      'claude-haiku-5-5',
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
      '--add-dir',
      FRAMES,
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
      input: `${sys}\n\n${usr}\n\nThe frame is the image file at ${framePath}. Open it with the Read tool and analyse only that image.`,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (run.error) throw run.error;
  let envelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    envelope = undefined;
  }
  if (run.status !== 0 || envelope?.is_error || !envelope?.structured_output)
    throw new Error(`claude vision failed: exit ${run.status}`);
  const p = envelope.structured_output;
  return {
    caption: String(p.caption || ''),
    ocrText: String(p.ocrText || ''),
    objects: Array.isArray(p.objects) ? p.objects.map(String) : [],
  };
}
let groqKeyIndex = 0;
async function analyzeWithGroq(file) {
  const keys = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keys.length) throw new Error('GROQ_API_KEYS is not set');
  const base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  const b64 = fs.readFileSync(FRAMES + file).toString('base64');
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const key = keys[groqKeyIndex++ % keys.length];
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: sys },
          {
            role: 'user',
            content: [
              { type: 'text', text: usr },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${b64}` },
              },
            ],
          },
        ],
        temperature: 0,
        max_completion_tokens: 700,
        response_format: { type: 'json_object' },
      }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const raw = await res.text();
    if (!res.ok)
      throw Object.assign(new Error(`groq status ${res.status}`), {
        status: res.status,
      });
    const p = JSON.parse(
      JSON.parse(raw).choices?.[0]?.message?.content ?? '{}',
    );
    return {
      caption: String(p.caption || ''),
      ocrText: String(p.ocrText || ''),
      objects: Array.isArray(p.objects) ? p.objects.map(String) : [],
    };
  }
  throw Object.assign(new Error('every Groq key rate limited'), {
    status: 429,
  });
}
async function analyzeWithOllama(file) {
  const base = (
    process.env.OLLAMA_VISION_BASE_URL || 'http://127.0.0.1:11434'
  ).replace(/\/+$/, '');
  const b64 = fs.readFileSync(FRAMES + file).toString('base64');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({
      model: process.env.OLLAMA_VISION_MODEL || 'gemma4:e4b-it-qat',
      stream: false,
      think: false,
      format: 'json',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: usr, images: [b64] },
      ],
      options: { temperature: 0, num_predict: 700 },
    }),
  });
  if (!res.ok)
    throw Object.assign(new Error(`ollama status ${res.status}`), {
      status: res.status,
    });
  const p = JSON.parse((await res.json()).message?.content ?? '{}');
  return {
    caption: String(p.caption || ''),
    ocrText: String(p.ocrText || ''),
    objects: Array.isArray(p.objects) ? p.objects.map(String) : [],
  };
}
async function analyze(file) {
  if (provider === 'claude') return analyzeWithClaude(file);
  if (provider === 'ollama') return analyzeWithOllama(file);
  if (provider === 'groq') return analyzeWithGroq(file);
  const b64 = fs.readFileSync(FRAMES + file).toString('base64');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: process.env.AI_VISION_MODEL,
      messages: [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: [
            { type: 'text', text: usr },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${b64}` },
            },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 700,
      stream: false,
      response_format: { type: 'json_object' },
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    const e = new Error(`status ${res.status}`);
    e.status = res.status;
    e.body = raw.slice(0, 160);
    throw e;
  }
  const content = JSON.parse(raw).choices?.[0]?.message?.content;
  const p = typeof content === 'string' ? JSON.parse(content) : content;
  return {
    caption: String(p.caption || ''),
    ocrText: String(p.ocrText || ''),
    objects: Array.isArray(p.objects) ? p.objects.map(String) : [],
  };
}
(async () => {
  let n = 0,
    fail = 0;
  for (const it of items.slice(0, limit)) {
    if (done.has(it.caseId)) continue;
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
      try {
        const r = await analyze(it.file);
        fs.appendFileSync(
          outFile,
          JSON.stringify({ caseId: it.caseId, file: it.file, variant, ...r }) +
            '\n',
        );
        ok = true;
        n++;
      } catch (e) {
        if (e.status === 429) {
          console.error('rate limited; stopping, rerun to resume');
          process.exit(2);
        }
        if (a === 2) {
          fail++;
          fs.appendFileSync(
            outFile,
            JSON.stringify({
              caseId: it.caseId,
              file: it.file,
              variant,
              error: String(e.message).slice(0, 100),
            }) + '\n',
          );
        } else await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
      }
    }
    process.stderr.write(`\r${variant} ${n} ok ${fail} failed`);
  }
  console.log(
    `\n${variant}: ${n} analysed, ${fail} failed, ${items.length} frames available`,
  );
})();
