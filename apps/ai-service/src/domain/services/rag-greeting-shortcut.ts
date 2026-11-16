import type { RagScopeConfig } from './rag-scope-policy';

/**
 * Whole-message greetings and thanks. The router model needs ~5 s on this host to
 * classify even these, so when the rule is enabled they skip it. Matching is
 * deliberately strict (the entire message, from a fixed list) so anything that also
 * asks something, like "thanks, but which episode...", still goes to the model.
 */
const GREETINGS = [
  'hi',
  'hello',
  'hey',
  'hiya',
  'yo',
  'good morning',
  'good afternoon',
  'good evening',
  'xin chao',
  'chao',
  'chao ban',
];

const THANKS = [
  'thanks',
  'thank you',
  'thank u',
  'thx',
  'ty',
  'thanks a lot',
  'thank you so much',
  'many thanks',
  'cheers',
  'cam on',
  'cam on ban',
  'cam on nhieu',
];

const ADDRESSEES = ['', ' there', ' velora', ' bot', ' ban'];
const PHRASES = new Set(
  [...GREETINGS, ...THANKS].flatMap((phrase) =>
    ADDRESSEES.map((suffix) => `${phrase}${suffix}`),
  ),
);

function normalize(message: string): string {
  return message
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGreetingOrThanksOnly(message: string): boolean {
  if (message.length > 60) return false;
  return PHRASES.has(normalize(message));
}

export function readRouterRulesEnabled(config?: RagScopeConfig): boolean {
  const raw = config?.get('AI_ROUTER_RULES_ENABLED');
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}
