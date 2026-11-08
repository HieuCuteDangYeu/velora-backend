import type { GuardrailFinding } from './rag-guardrail.types';

export interface OutputGuardrailInput {
  answer: string;
  /** Used so an ID the user typed themselves is not reported as a leak. */
  userMessage: string;
  citations: ReadonlyArray<{ reelId: string }>;
  accessibleReelIds: readonly string[];
}

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const OBJECT_ID = /\b[0-9a-f]{24}\b/gi;
const STORAGE_KEY =
  /\b[\w-]+\/[\w./-]+\.(?:mp4|mov|m4a|webm|jpe?g|png|vtt|m3u8)\b/i;
const REMOTE_IMAGE = /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\)/;
const REMOTE_IMAGE_WITH_QUERY =
  /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\?[^)\s]*=[^)\s]*\)/;

const SECRET_SHAPES: readonly RegExp[] = [
  /\bgsk_[A-Za-z0-9]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i,
];

/**
 * Distinctive headings of the system prompt. A spec asserts each still appears
 * in the prompt builder, so this list cannot silently drift.
 */
export const SYSTEM_PROMPT_MARKERS: readonly string[] = [
  'security rules for retrieved reel evidence',
  'route and evidence decision',
  'retrieved shared reel evidence',
  'you are velora ai, an intelligent assistant',
  'long-term user memory:',
  'answering rules:',
];

/** Screens a finished answer, before the user sees it, for leaks and cross-tenant citations. */
export function evaluateOutputGuardrail(
  input: OutputGuardrailInput,
): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  const add = (code: string, severity: 'medium' | 'high') =>
    findings.push({ check: 'output', code, severity });
  const answer = input.answer;
  const lowered = answer.toLowerCase();

  if (SECRET_SHAPES.some((shape) => shape.test(answer))) {
    add('SECRET_LEAK', 'high');
  }

  const markers = SYSTEM_PROMPT_MARKERS.filter((marker) =>
    lowered.includes(marker),
  ).length;
  if (markers > 0) add('PROMPT_LEAK', markers >= 2 ? 'high' : 'medium');

  const typedByUser = input.userMessage.toLowerCase();
  const leakedIds = [
    ...(answer.match(UUID) ?? []),
    ...(answer.match(OBJECT_ID) ?? []),
  ].filter((id) => !typedByUser.includes(id.toLowerCase()));
  if (leakedIds.length > 0) {
    const accessible = new Set(
      input.accessibleReelIds.map((id) => id.toLowerCase()),
    );
    add(
      'ID_LEAK',
      leakedIds.some((id) => accessible.has(id.toLowerCase()))
        ? 'high'
        : 'medium',
    );
  }

  if (STORAGE_KEY.test(answer)) add('STORAGE_KEY_LEAK', 'medium');

  if (REMOTE_IMAGE_WITH_QUERY.test(answer)) add('EXFILTRATION', 'high');
  else if (REMOTE_IMAGE.test(answer)) add('EXFILTRATION', 'medium');

  const accessible = new Set(input.accessibleReelIds);
  if (input.citations.some((citation) => !accessible.has(citation.reelId))) {
    add('TENANT_VIOLATION', 'high');
  }

  return findings;
}
