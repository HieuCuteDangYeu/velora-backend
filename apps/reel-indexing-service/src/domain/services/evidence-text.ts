// Chinese and Japanese are written without spaces, but Whisper hands back one
// token per word (often one per character) and the chunker joins tokens with a
// space. "我 走 叔" embeds and reranks as noise and scores high against
// unrelated queries, so no space is kept between two such characters.
const CJK_GAP =
  /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;

export function normalizeEvidenceText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(CJK_GAP, '');
}
