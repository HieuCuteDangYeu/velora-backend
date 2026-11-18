import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateEvidenceGuardrail } from './rag-evidence-guardrail';
import { evaluateInputGuardrail } from './rag-input-guardrail';
import { evaluateMemoryGuardrail } from './rag-memory-guardrail';
import { evaluateOutputGuardrail } from './rag-output-guardrail';
import type { GuardrailFinding } from './rag-guardrail.types';

/**
 * Opt-in replay of saved real traffic. Walks every JSON and JSONL file under GUARDRAIL_REPLAY_DIR
 * (benchmark runs hold real reel evidence, answers and questions) and counts what each
 * check would have flagged or blocked. All of it is ordinary traffic, so every high
 * finding is a false positive until a human says otherwise.
 *
 *   GUARDRAIL_REPLAY_DIR=.benchmarks/groq-hybrid-20261113 npx jest rag-guardrail.replay.local
 *
 * Prints counts and a few truncated examples per code; asserts nothing about content.
 */
const dir = process.env.GUARDRAIL_REPLAY_DIR;
const localIt = dir ? it : it.skip;

type Json = unknown;
const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: Json): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

function* jsonFiles(root: string): Generator<string> {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(path);
    } catch {
      continue; // broken symlink
    }
    if (info.isDirectory()) yield* jsonFiles(path);
    else if (name.endsWith('.json') || name.endsWith('.jsonl')) yield path;
  }
}

interface Corpus {
  evidence: Array<{
    evidenceText?: string;
    title?: string;
    description?: string;
    tags?: string[];
  }>;
  answers: Array<{ answer: string; reelIds: string[] }>;
  questions: string[];
  stored: string[];
}

function collect(root: string): Corpus {
  const corpus: Corpus = {
    evidence: [],
    answers: [],
    questions: [],
    stored: [],
  };
  const seen = new Set<string>();
  const once = (kind: string, value: string) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const walk = (node: Json) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isRecord(node)) return;

    const evidenceText = text(node.evidenceText) ?? text(node.chunkText);
    if (evidenceText && once('evidence', evidenceText)) {
      corpus.evidence.push({
        evidenceText,
        title: text(node.title),
        description: text(node.description),
        tags: Array.isArray(node.tags)
          ? node.tags.filter((tag): tag is string => typeof tag === 'string')
          : undefined,
      });
    }
    const answer = text(node.answer);
    if (answer && once('answer', answer)) {
      const reelIds = new Set<string>();
      if (text(node.reelId)) reelIds.add(node.reelId as string);
      if (Array.isArray(node.citations)) {
        for (const citation of node.citations) {
          if (isRecord(citation) && text(citation.reelId)) {
            reelIds.add(citation.reelId as string);
          }
        }
      }
      corpus.answers.push({ answer, reelIds: [...reelIds] });
      corpus.stored.push(answer);
    }
    for (const key of ['question', 'message', 'prompt', 'userMessage']) {
      const question = text(node[key]);
      if (question && once('question', question)) {
        corpus.questions.push(question);
      }
    }
    const summary = text(node.derivedSummary);
    if (summary && once('summary', summary)) corpus.stored.push(summary);

    Object.values(node).forEach(walk);
  };

  for (const file of jsonFiles(root)) {
    const raw = readFileSync(file, 'utf8');
    try {
      if (file.endsWith('.jsonl')) {
        for (const line of raw.split('\n')) {
          if (line.trim()) walk(JSON.parse(line));
        }
      } else {
        walk(JSON.parse(raw));
      }
    } catch {
      // not a JSON benchmark artefact
    }
  }
  return corpus;
}

function tally(
  label: string,
  samples: Array<{ text: string; findings: GuardrailFinding[] }>,
) {
  const byCode = new Map<
    string,
    { high: number; medium: number; ex: string[] }
  >();
  let flagged = 0;
  let high = 0;
  for (const sample of samples) {
    if (sample.findings.length > 0) flagged += 1;
    if (sample.findings.some((finding) => finding.severity === 'high'))
      high += 1;
    for (const finding of sample.findings) {
      const entry = byCode.get(finding.code) ?? { high: 0, medium: 0, ex: [] };
      entry[finding.severity] += 1;
      if (finding.severity === 'high' && entry.ex.length < 4) {
        entry.ex.push(sample.text.replace(/\s+/g, ' ').slice(0, 160));
      }
      byCode.set(finding.code, entry);
    }
  }
  const pct = (n: number) =>
    `${((100 * n) / Math.max(samples.length, 1)).toFixed(2)}%`;
  return [
    `${label}: n=${samples.length} flagged=${flagged} (${pct(flagged)}) HIGH=${high} (${pct(high)})`,
    ...[...byCode].map(
      ([code, entry]) =>
        `   ${code}: high=${entry.high} medium=${entry.medium}` +
        entry.ex.map((example) => `\n      e.g. ${example}`).join(''),
    ),
  ].join('\n');
}

describe('guardrail replay over saved traffic (opt-in)', () => {
  localIt(
    'reports what each check would flag on real evidence, answers and questions',
    () => {
      const corpus = collect(join(process.cwd(), dir as string));
      expect(corpus.evidence.length + corpus.answers.length).toBeGreaterThan(0);

      const report = [
        tally(
          'EVIDENCE (real reel chunks)',
          corpus.evidence.map((item) => ({
            text: item.evidenceText ?? '',
            findings: evaluateEvidenceGuardrail([item]),
          })),
        ),
        tally(
          'OUTPUT (real answers)',
          corpus.answers.map((item) => ({
            text: item.answer,
            findings: evaluateOutputGuardrail({
              answer: item.answer,
              userMessage: '',
              citations: item.reelIds.map((reelId) => ({ reelId })),
              accessibleReelIds: item.reelIds,
            }),
          })),
        ),
        tally(
          'INPUT (real questions, with decoders)',
          corpus.questions.map((question) => ({
            text: question,
            findings: evaluateInputGuardrail(question),
          })),
        ),
        tally(
          'MEMORY (real answers + derived summaries as stored text)',
          corpus.stored.map((item) => ({
            text: item,
            findings: evaluateMemoryGuardrail(item),
          })),
        ),
      ].join('\n\n');
      console.log(`\n${report}\n`);
    },
  );
});
