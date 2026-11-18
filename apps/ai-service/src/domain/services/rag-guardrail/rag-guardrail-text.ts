/**
 * Text normalisation for screening only. The output is matched against
 * patterns and never shown to a model or a user.
 *
 * `plain` is the lowercase, diacritic-folded form (so one Vietnamese pattern
 * matches both accented and unaccented typing). `deobfuscated` additionally
 * undoes tricks that exist only to evade matching. A pattern that hits
 * `deobfuscated` but not `plain` was deliberately disguised.
 */

// Escaped on purpose: written as a string so no formatter can turn these into
// literal invisible characters. Soft hyphen, zero-width, bidi and variation selectors.
/* eslint-disable no-misleading-character-class -- combining marks are the point of this class */
const INVISIBLE = new RegExp(
  '[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0]',
  'g',
);
/* eslint-enable no-misleading-character-class */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Visually identical Cyrillic/Greek letters mapped to the Latin letter they imitate.
const HOMOGLYPHS: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ɡ: 'g',
  ο: 'o',
  α: 'a',
  ν: 'v',
  ρ: 'p',
  ι: 'i',
  τ: 't',
  κ: 'k',
  // Further Cyrillic, Greek and Armenian letters that pass for a Latin one in most fonts.
  к: 'k',
  м: 'm',
  н: 'h',
  т: 't',
  в: 'b',
  ѵ: 'v',
  ԛ: 'q',
  ԝ: 'w',
  ε: 'e',
  η: 'n',
  μ: 'u',
  β: 'b',
  γ: 'y',
  ω: 'w',
  υ: 'u',
  ս: 'u',
  ո: 'n',
  ɑ: 'a',
  ꞵ: 'b',
};
const HOMOGLYPH_PATTERN = new RegExp(
  `[${Object.keys(HOMOGLYPHS).join('')}]`,
  'g',
);

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

export interface NormalizedText {
  plain: string;
  deobfuscated: string;
}

function foldPlain(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

export function normalizeForScreening(text: string): NormalizedText {
  const plain = foldPlain(text);

  const deobfuscated = foldPlain(
    text
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .replace(CONTROL, '')
      // A wider gap between spaced-out letters is a word break: keep it through the
      // whitespace folding, then restore it as a single space below.
      .replace(/(?<=[a-z]) {2,}(?=[a-z](?: |$))/gi, ' \u0001 '),
  )
    .replace(HOMOGLYPH_PATTERN, (char) => HOMOGLYPHS[char] ?? char)
    // 1gn0re, pr3v10us: only inside tokens that mix letters and look-alike symbols.
    .replace(/[a-z0-9@$]{4,}/g, (token) =>
      /[a-z]/.test(token) && /[0-9@$]/.test(token)
        ? token.replace(/[0-9@$]/g, (char) => LEET[char] ?? char)
        : token,
    )
    // i.g.n.o.r.e / i g n o r e: four or more single letters joined by separators.
    .replace(/\b(?:[a-z][ .\-_*]){3,}[a-z]\b/g, (run) =>
      run.replace(/[ .\-_*]/g, ''),
    )
    // eslint-disable-next-line no-control-regex -- the word-gap marker added above
    .replace(/ ?\u0001 ?/g, ' ');

  return { plain, deobfuscated };
}

const BASE64_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const MAX_DECODED_CHARS = 8_000;

function printableText(value: string): string | undefined {
  if (value.length < 12) return undefined;
  const printable = value.match(/[\x20-\x7E\n\t]/g)?.length ?? 0;
  return printable / value.length > 0.9 ? value : undefined;
}

/** Decodes plausible base64 (and base64url) runs so an encoded payload is screened like plain text. */
export function decodeBase64Candidates(text: string, limit = 4): string[] {
  const decoded: string[] = [];
  for (const run of text.match(BASE64_RUN) ?? []) {
    if (decoded.length >= limit) break;
    const value = printableText(
      Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      ),
    );
    if (value) decoded.push(value);
  }
  return decoded;
}

function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** "%69%67%6e%6f%72%65", "&#105;&#103;", "ig": escapes that spell a payload out letter by letter. */
function decodeEscapes(text: string): string | undefined {
  if (
    !/(?:%[0-9a-f]{2}|&#x?[0-9a-f]+;|\\u[0-9a-f]{4}|\\x[0-9a-f]{2})/i.test(text)
  ) {
    return undefined;
  }
  const decoded = text
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)),
    )
    .replace(/&#(\d+);/g, (_, num: string) =>
      String.fromCodePoint(Math.min(parseInt(num, 10), 0x10ffff)),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  return decoded === text ? undefined : decoded;
}

// Separated pairs ("69 67 6e", "0x69,0x67") or one unbroken run ("69676e6f"). An ObjectId decodes to binary and is dropped as unprintable.
const HEX_RUN =
  /(?:\b(?:0x)?[0-9a-f]{2}\b[\s,:]*){12,}|\b(?:[0-9a-f]{2}){12,}\b/gi;

function decodeHexRuns(text: string): string[] {
  const decoded: string[] = [];
  for (const run of text.match(HEX_RUN) ?? []) {
    const hex = run.replace(/0x|[\s,:]/gi, '');
    if (hex.length % 2 !== 0) continue;
    const value = printableText(Buffer.from(hex, 'hex').toString('utf8'));
    if (value) decoded.push(value);
  }
  return decoded;
}

/**
 * Every re-encoding of a message that is worth screening again: base64/base64url,
 * hex, percent / HTML / unicode escapes, ROT13 and reversed text. A hit on any of
 * them is deliberate: ordinary text is never written this way.
 */
export function decodeEncodedCandidates(text: string, limit = 8): string[] {
  const candidates: string[] = [...decodeBase64Candidates(text)];
  candidates.push(...decodeHexRuns(text).slice(0, 2));

  const escaped = decodeEscapes(text);
  if (escaped) candidates.push(escaped);

  // Whole-message transforms: they only matter when the plain form hides a sentence.
  candidates.push(rot13(text));
  candidates.push([...text].reverse().join(''));

  return candidates
    .map((candidate) => candidate.slice(0, MAX_DECODED_CHARS))
    .slice(0, limit);
}
