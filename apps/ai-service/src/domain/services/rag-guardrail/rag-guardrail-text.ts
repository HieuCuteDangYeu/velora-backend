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
    text.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, ''),
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
    );

  return { plain, deobfuscated };
}

const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g;

/** Decodes plausible base64 runs so an encoded payload is screened like plain text. */
export function decodeBase64Candidates(text: string, limit = 4): string[] {
  const decoded: string[] = [];
  for (const run of text.match(BASE64_RUN) ?? []) {
    if (decoded.length >= limit) break;
    const value = Buffer.from(run, 'base64').toString('utf8');
    const printable = value.match(/[\x20-\x7E\n\t]/g)?.length ?? 0;
    if (value.length >= 12 && printable / value.length > 0.9) {
      decoded.push(value);
    }
  }
  return decoded;
}
