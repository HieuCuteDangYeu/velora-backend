import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardrailFinding } from './rag-guardrail.types';
import { evaluateEvidenceGuardrail } from './rag-evidence-guardrail';
import { evaluateInputGuardrail } from './rag-input-guardrail';
import { evaluateOutputGuardrail } from './rag-output-guardrail';

/**
 * Offline replay: no provider calls, no network. It is the gate that must pass
 * before any check is allowed to enforce.
 *  - every `block` case produces a high finding,
 *  - every `flag` case produces a finding but no high one,
 *  - no `allow` case (hard negatives) and no real benchmark question produces a high finding.
 */

interface GuardrailCase {
  id: string;
  channel: 'user' | 'evidence' | 'answer';
  category: string;
  language: string;
  expect: 'block' | 'flag' | 'allow';
  text: string;
  tags?: string[];
  title?: string;
  description?: string;
  citations?: Array<{ reelId: string }>;
  accessibleReelIds?: string[];
}

const root = process.cwd();
const readJsonl = <T>(relative: string): T[] =>
  readFileSync(join(root, relative), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

const run = (testCase: GuardrailCase): GuardrailFinding[] => {
  if (testCase.channel === 'user') return evaluateInputGuardrail(testCase.text);
  if (testCase.channel === 'evidence') {
    return evaluateEvidenceGuardrail([
      {
        chunkText: testCase.text,
        tags: testCase.tags,
        title: testCase.title,
        description: testCase.description,
      },
    ]);
  }
  return evaluateOutputGuardrail({
    answer: testCase.text,
    userMessage: '',
    citations: testCase.citations ?? [],
    accessibleReelIds: testCase.accessibleReelIds ?? [],
  });
};

const high = (findings: GuardrailFinding[]) =>
  findings.some((finding) => finding.severity === 'high');

describe('guardrail replay: attack and hard-negative dataset', () => {
  const cases = readJsonl<GuardrailCase>(
    'eval/rag/datasets/rag-guardrail-v1.jsonl',
  );

  it('covers every channel and expectation', () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
    for (const channel of ['user', 'evidence', 'answer']) {
      for (const expectation of ['block', 'allow']) {
        expect(
          cases.some((c) => c.channel === channel && c.expect === expectation),
        ).toBe(true);
      }
    }
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, testCase) => {
    const findings = run(testCase);
    const label = `${testCase.channel}/${testCase.category}/${testCase.language}: ${JSON.stringify(testCase.text).slice(0, 90)}`;
    if (testCase.expect === 'block') {
      expect({ label, high: high(findings) }).toEqual({ label, high: true });
    } else if (testCase.expect === 'flag') {
      expect({ label, found: findings.length > 0 }).toEqual({
        label,
        found: true,
      });
      expect({ label, high: high(findings) }).toEqual({ label, high: false });
    } else {
      expect({ label, high: high(findings) }).toEqual({ label, high: false });
    }
  });
});

describe('guardrail replay: real benchmark questions must never be blocked', () => {
  const datasets = [
    'eval/rag/datasets/rag-scraped-v1-provisional.jsonl',
    'eval/rag/datasets/rag-generalization-v1.jsonl',
  ];

  it.each(datasets)('%s', (path) => {
    const questions = readJsonl<{ id: string; question: string }>(path);
    expect(questions.length).toBeGreaterThan(50);
    const blocked = questions.filter((row) =>
      high(evaluateInputGuardrail(row.question)),
    );
    expect(blocked.map((row) => row.id)).toEqual([]);
    const flagged = questions.filter(
      (row) => evaluateInputGuardrail(row.question).length > 0,
    );
    // Medium signals are tolerated but should stay rare on genuine questions.
    expect(flagged.length / questions.length).toBeLessThanOrEqual(0.02);
  });
});
