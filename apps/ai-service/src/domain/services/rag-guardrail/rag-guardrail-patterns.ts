import type { GuardrailSeverity } from './rag-guardrail.types';
import { INPUT_ONLY_PATTERNS } from './rag-guardrail-input-patterns';
import type { NormalizedText } from './rag-guardrail-text';

export interface GuardrailPattern {
  code: string;
  severity: GuardrailSeverity;
  pattern: RegExp;
}

export interface PatternHit {
  code: string;
  severity: GuardrailSeverity;
  obfuscated: boolean;
}

/*
 * Every pattern runs against diacritic-folded lowercase text, so Vietnamese
 * rules are written without tone marks. Patterns target an attempt to control
 * the assistant itself ("your", "previous", "system"), not ordinary uses of
 * words like "ignore" or "instructions" ("ignore the instructions on the box").
 */

const INSTRUCTION_OVERRIDE: GuardrailPattern[] = [
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|every\s+)?(?:of\s+)?(?:(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|former|original|initial|system|developer)|your)\s+(?:instructions?|prompts?|rules?|guidelines?|directions?|directives?|constraints?|policy|policies|programming|restrictions?|commands?)\b/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:all|any|every)\s+(?:instructions?|rules?|prompts?|guidelines?)\b/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:ignore|disregard|forget)\s+everything\s+(?:above|before|you\s+(?:were|have\s+been)\s+(?:told|given)|i\s+said)\b/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:do\s+not|don'?t|never|stop)\s+(?:follow(?:ing)?|obey(?:ing)?)\s+(?:your|the\s+(?:system|developer))\s+(?:instructions?|rules?|guidelines?|prompt)/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:bo\s+qua|lo\s+di|quen)\s+(?:het\s+|tat\s+ca\s+|moi\s+)?(?:cac\s+)?(?:huong\s+dan|chi\s+dan|chi\s+thi|quy\s+tac|rang\s+buoc|lenh)\s+(?:truoc|ben\s+tren|o\s+tren|he\s+thong|cua\s+ban|cua\s+he\s+thong)/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:bo\s+qua|quen)\s+(?:het\s+|tat\s+ca\s+|moi\s+thu\s+)(?:nhung\s+gi\s+)?(?:o\s+tren|ben\s+tren|truoc\s+do|ban\s+da\s+(?:duoc|bi)\s+bao)/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:khong|dung)\s+(?:can\s+)?(?:tuan\s+theo|lam\s+theo)\s+(?:cac\s+)?(?:huong\s+dan|quy\s+tac|chi\s+dan)\s+(?:cua\s+ban|he\s+thong)/,
  },
  // "Ignore your current restrictions", "set aside your usual rules": addressed to the assistant
  // by "your", with up to three qualifiers in between (found missing in production, 2026-11-12).
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:forget|ignore|disregard|drop|bypass|override|suspend|waive|lift|disable|set\s+aside|put\s+aside)\s+(?:about\s+)?(?:all\s+|any\s+|every\s+|of\s+)*your\s+(?:[a-z-]+\s+){0,3}?(?:rules?|instructions?|guidelines?|restrictions?|constraints?|guardrails?|policies|policy|safeguards?)\b/,
  },
  // "Forget about the current strict rules": no "your", but "current/existing/usual" combined with
  // a qualifier that only makes sense for an assistant's own limits.
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:forget|ignore|disregard|drop|bypass|override|suspend|waive|set\s+aside|put\s+aside)\s+(?:about\s+)?(?:all\s+|any\s+|every\s+|of\s+)*(?:the\s+|these\s+|those\s+)?(?:current|existing|usual|normal|standard|default)\s+(?:strict|safety|content|hidden|internal|built-?in)\s+(?:rules?|instructions?|guidelines?|restrictions?|constraints?|guardrails?|policies|policy)\b/,
  },
  // The same without the extra qualifier ("forget the current rules") is ambiguous in normal use.
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'medium',
    pattern:
      /\b(?:forget|ignore|disregard|drop|bypass|override|suspend|waive|set\s+aside|put\s+aside)\s+(?:about\s+)?(?:all\s+|any\s+|every\s+|of\s+)*(?:the\s+|these\s+|those\s+)?(?:current|existing|usual|strict)\s+(?:rules?|instructions?|guidelines?|restrictions?|constraints?|guardrails?|policies|policy)\b/,
  },
  // Vietnamese (diacritics folded): "quên các quy tắc hiện tại đi", "bỏ qua các quy tắc nghiêm ngặt hiện tại".
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'high',
    pattern:
      /\b(?:bo\s+qua|lo\s+di|quen|vut\s+bo|huy\s+bo|go\s+bo)\s+(?:di\s+)?(?:het\s+|tat\s+ca\s+|moi\s+)?(?:cac\s+)?(?:quy\s+tac|huong\s+dan|chi\s+dan|quy\s+dinh|rang\s+buoc)\s+(?:nghiem\s+ngat\s+)?(?:hien\s+tai|hien\s+co|dang\s+co|hien\s+hanh|cua\s+ban)/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'medium',
    pattern: /\bnew\s+(?:instructions?|rules?|system\s+prompt)\s*:/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'medium',
    pattern:
      /\bfrom\s+now\s+on\b[^.\n]{0,40}\byou\s+(?:are|will|must|should|shall|can)\b/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'medium',
    pattern:
      /\byour\s+(?:new|real|true|actual)\s+(?:instructions?|task|role|purpose|goal)\b/,
  },
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'medium',
    pattern:
      /\btu\s+bay\s+gio\s*,?\s*(?:ban|may|em|ngai)\s+(?:la|se|phai|hay)\b/,
  },
];

const PROMPT_EXTRACTION: GuardrailPattern[] = [
  {
    code: 'PROMPT_EXTRACTION',
    severity: 'high',
    pattern:
      /\b(?:reveal|show|print|display|repeat|output|leak|expose|dump|tell|give|send|write|recite|paste|copy)\b[^.\n]{0,30}\b(?:your\s+(?:(?:initial|original|hidden|secret|internal|underlying|system|developer)\s+){1,3}|the\s+(?:(?:hidden|secret|internal|underlying)\s+)*(?:system|developer)\s+)(?:prompts?|instructions?|messages?|rules?|guidelines?|configuration|config)\b/,
  },
  {
    code: 'PROMPT_EXTRACTION',
    severity: 'high',
    pattern:
      /\b(?:hidden|secret|internal|underlying)\s+(?:rules|instructions|prompt|guidelines)\s+(?:you|that\s+you)\s+(?:were|have\s+been|are)\s+(?:given|told|following)\b/,
  },
  {
    code: 'PROMPT_EXTRACTION',
    severity: 'high',
    pattern:
      /\brepeat\s+(?:the\s+|your\s+)?(?:words|text|everything|all)\s+(?:above|before)\b/,
  },
  {
    code: 'PROMPT_EXTRACTION',
    severity: 'high',
    pattern:
      /\b(?:cho\s+(?:toi|minh|tao)\s+xem|tiet\s+lo|in\s+ra|hien\s+thi|lap\s+lai|doc\s+lai|noi\s+cho\s+(?:toi|minh)\s+biet)\s+[^.\n]{0,25}(?:system\s*prompt|prompt\s+he\s+thong|huong\s+dan\s+he\s+thong|chi\s+dan\s+he\s+thong|quy\s+tac\s+(?:an(?!\s+(?:toan|ninh))|noi\s+bo)|huong\s+dan\s+(?:ban\s+dau|goc|an(?!\s+(?:toan|ninh))))/,
  },
  {
    code: 'PROMPT_EXTRACTION',
    severity: 'medium',
    pattern:
      /\bwhat\s+(?:is|are|were)\s+your\s+(?:system\s+|initial\s+|original\s+|hidden\s+)?(?:instructions?|prompt|rules?|guidelines?)\b/,
  },
  {
    code: 'PROMPT_EXTRACTION',
    severity: 'medium',
    pattern: /\bsystem\s+prompt\b/,
  },
];

const JAILBREAK_PERSONA: GuardrailPattern[] = [
  {
    code: 'JAILBREAK_PERSONA',
    severity: 'high',
    pattern: /\bdan\s+mode\b|\bdo\s+anything\s+now\b/,
  },
  {
    code: 'JAILBREAK_PERSONA',
    severity: 'high',
    pattern:
      /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken)\b/,
  },
  {
    code: 'JAILBREAK_PERSONA',
    severity: 'high',
    pattern:
      /\bpretend\s+(?:that\s+)?(?:you|to\s+be)\b[^.\n]{0,60}\b(?:no|without)\s+(?:rules|restrictions|limits|limitations|filters|guidelines)\b/,
  },
  {
    code: 'JAILBREAK_PERSONA',
    severity: 'high',
    pattern: /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored)\b/,
  },
  {
    code: 'JAILBREAK_PERSONA',
    severity: 'medium',
    pattern:
      /\b(?:developer|debug|admin|god|sudo)\s+mode\b|\bjailbreak(?:ing|ed)?\b/,
  },
];

const ROLE_TAG: GuardrailPattern[] = [
  {
    code: 'ROLE_TAG',
    severity: 'high',
    pattern:
      /<\|\s*(?:im_start|im_end|system|endoftext|assistant)\s*\|>|\[\/?(?:inst|sys)\]|<<\s*\/?sys\s*>>/,
  },
  {
    code: 'ROLE_TAG',
    severity: 'medium',
    pattern: /(?:^|\n)\s*(?:system|assistant|developer)\s*:/,
  },
];

const EXFILTRATION: GuardrailPattern[] = [
  {
    code: 'EXFILTRATION',
    severity: 'medium',
    pattern: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\)/,
  },
  {
    code: 'EXFILTRATION',
    severity: 'high',
    pattern:
      /\b(?:send|post|upload|forward|exfiltrate|leak|transmit)\b[^.\n]{0,40}\b(?:conversation|chat\s+history|history|memor(?:y|ies)|user\s+data|personal\s+data|secrets?|api\s*keys?|credentials|tokens?)\b[^.\n]{0,40}\bto\b[^.\n]{0,20}(?:https?:|www\.)/,
  },
];

const INTERNAL_DISCLOSURE: GuardrailPattern[] = [
  {
    code: 'INTERNAL_DISCLOSURE',
    severity: 'medium',
    pattern:
      /\b(?:reveal|show|list|dump|print|leak|expose|give|tell)\b[^.\n]{0,25}\b(?:api[\s_-]?keys?|environment\s+variables?|\.env\b|access\s+tokens?|chunk\s+ids?|internal\s+(?:reel\s+)?ids?|reel\s+ids?|storage\s+keys?|retrieval\s+scores?|connection\s+string|database\s+(?:credentials|password))/,
  },
];

/** Text addressed to the assistant rather than to a viewer: typical of planted payloads. */
const ASSISTANT_ADDRESSED: GuardrailPattern[] = [
  {
    code: 'ASSISTANT_ADDRESSED',
    severity: 'medium',
    pattern:
      /\b(?:attention|note|important|hey|hello|dear)\s*[,:!]?\s*(?:ai|assistant|chatbot|llm|language\s+model|velora(?:\s+ai)?|gpt|claude)\b/,
  },
  {
    code: 'ASSISTANT_ADDRESSED',
    severity: 'medium',
    pattern:
      /\b(?:ai|assistant|chatbot|llm|language\s+model|velora\s+ai)\s*[,:]\s*(?:you\s+(?:must|should|need\s+to|will|are\s+to)|please\s+|ignore|disregard|reveal|respond|answer|say|output|tell|do\s+not)/,
  },
  {
    code: 'ASSISTANT_ADDRESSED',
    severity: 'medium',
    pattern:
      /\bif\s+you\s+are\s+(?:an?\s+)?(?:ai|assistant|llm|language\s+model|chatbot|large\s+language)\b/,
  },
  {
    code: 'ASSISTANT_ADDRESSED',
    severity: 'medium',
    pattern:
      /\bwhen\s+(?:asked|summari[sz]ing|answering|responding)\b[^.\n]{0,60}\b(?:you\s+(?:must|should|will)|always|only)\s+(?:say|respond|answer|reply|output|write|mention)\b/,
  },
  {
    code: 'ASSISTANT_ADDRESSED',
    severity: 'medium',
    pattern:
      /\b(?:tell|instruct|ask|direct|urge)\s+the\s+(?:user|reader|human)s?\s+to\s+(?:visit|click|open|go\s+to|download|install|send|enter|share)\b/,
  },
  {
    code: 'ASSISTANT_ADDRESSED',
    severity: 'medium',
    pattern:
      /\b(?:ai|tro\s+ly|chatbot|velora)\s*[,:]\s*(?:ban\s+(?:phai|hay|can)|hay\s|vui\s+long|bo\s+qua)/,
  },
];

const SHARED = [
  ...INSTRUCTION_OVERRIDE,
  ...PROMPT_EXTRACTION,
  ...JAILBREAK_PERSONA,
  ...ROLE_TAG,
  ...EXFILTRATION,
];

/** What a user types to the assistant. */
export const INPUT_PATTERNS: readonly GuardrailPattern[] = [
  ...SHARED,
  ...INTERNAL_DISCLOSURE,
  ...INPUT_ONLY_PATTERNS,
];

/** What a reel's transcript, OCR text, title or tags must not contain. */
export const EVIDENCE_PATTERNS: readonly GuardrailPattern[] = [
  ...SHARED,
  ...ASSISTANT_ADDRESSED,
];

/**
 * Returns one hit per code (the most severe), flagged `obfuscated` when only
 * the de-obfuscated text matched.
 */
export function matchGuardrailPatterns(
  patterns: readonly GuardrailPattern[],
  text: NormalizedText,
): PatternHit[] {
  const hits = new Map<string, PatternHit>();
  for (const { code, severity, pattern } of patterns) {
    const onDeobfuscated = pattern.test(text.deobfuscated);
    if (!onDeobfuscated && !pattern.test(text.plain)) continue;
    const hit: PatternHit = {
      code,
      severity,
      obfuscated: !pattern.test(text.plain),
    };
    const existing = hits.get(code);
    if (
      !existing ||
      (severity === 'high' && existing.severity !== 'high') ||
      (severity === existing.severity && existing.obfuscated && !hit.obfuscated)
    ) {
      hits.set(code, hit);
    }
  }
  return [...hits.values()];
}
