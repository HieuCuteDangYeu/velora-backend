/**
 * Spots a message that explicitly asks the assistant to recall something said earlier in the
 * chat ("do you remember...", "what did I tell you about...", "mình nói sẽ đi đâu nhỉ?").
 * The router usually labels such a message as a conversation-memory question, but a small
 * model sometimes calls it normal chat; this is the safety net for that miss. It is
 * deliberately narrow: wording that means "recall", not any message that mentions the past.
 */

const NOT_LETTER = '(?<![\\p{L}\\p{N}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{N}])';
const word = (source: string): RegExp =>
  new RegExp(`${NOT_LETTER}(?:${source})${NOT_LETTER_AFTER}`, 'iu');

const ENGLISH: RegExp[] = [
  // "do you remember the pasta I mentioned?", but not "remember to call mom"
  word(
    '(?:do|did|can|could|would|will) you (?:still |even )?(?:remember|recall)',
  ),
  // "what did I say", "which food did I mention": past tense only, so "how do I share" is not a cue
  word(
    '(?:what|which|where|when|who)(?: \\w+){0,3} (?:did|was|were) (?:i|we) (?:say|said|tell|told|mention|mentioned|ask|asked|talk|talked|discuss|discussed|share|shared|send|sent|upload|uploaded)',
  ),
  word('did i (?:ever )?(?:say|tell|mention|ask|share|send|upload)'),
  // "what I told you earlier", "as I mentioned above"
  word(
    '(?:i|we) (?:said|told you|mentioned|asked you|talked about|shared|sent|uploaded)(?: \\w+){0,4} (?:earlier|before|previously|above|ago|last time)',
  ),
  word(
    '(?:earlier|before|previously|above|last time)(?: \\w+){0,4} (?:i|we) (?:said|told|mentioned|asked|shared|sent|uploaded)',
  ),
  // "the photo I sent", "the picture I uploaded"
  word(
    '(?:photos?|pictures?|images?|pics?|screenshots?|selfies?) (?:that )?(?:i|we) (?:sent|uploaded|shared|attached|posted|gave|showed)',
  ),
];

const VIETNAMESE: RegExp[] = [
  // nhớ = remember: "bạn còn nhớ ... không", "có nhớ ... không"
  word('(?:còn|có|vẫn) nhớ'),
  word('nhớ (?:không|ko|chứ|gì|lại)'),
  // "mình nói / kể / hỏi / gửi ... nhỉ|không|gì|đâu|nào"
  word(
    '(?:mình|tôi|tớ|em|anh|chị|tui) (?:đã |vừa |hồi nãy |lúc nãy |ban nãy )?(?:nói|kể|bảo|nhắc|hỏi|gửi|chia sẻ|đề cập)',
  ),
];

/** A Vietnamese cue also needs to be a question, since "mình nói thật" is plain talk. */
const VIETNAMESE_QUESTION = word(
  'nhỉ|không|ko|chưa|gì|đâu|nào|sao|thế nào|hả|ai|bao nhiêu|mấy',
);

export function looksLikeRecallQuestion(message: string): boolean {
  const text = message.normalize('NFC').toLowerCase();
  if (ENGLISH.some((pattern) => pattern.test(text))) return true;
  const vietnamese = VIETNAMESE.some((pattern) => pattern.test(text));
  return vietnamese && (text.includes('?') || VIETNAMESE_QUESTION.test(text));
}
