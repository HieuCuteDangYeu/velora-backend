import type { AiChatMessageContext } from '@common/ai/interfaces/chat-memory-context.interface';

/**
 * Picks the few earlier chat messages that a question about the conversation is
 * asking for ("do you remember the pasta I mentioned?"). The score is a blend of
 * meaning (cosine similarity from an embedding, when one was computed) and shared
 * words, so a question worded differently from the message still finds it and an
 * unavailable embedding service still leaves word matching.
 */

export interface RecallRankingOptions {
  /** How many messages to return. */
  limit: number;
  /** A message counts as relevant by meaning at or above this cosine similarity. */
  minSemantic: number;
  /** ...or by words at or above this weighted share of the question's content words. */
  minLexical: number;
  /** Weight of the embedding in the blended score; the rest is the word score. */
  semanticWeight: number;
  /** Only messages scoring within this much of the best match are kept, so weak ones do not tag along. */
  margin: number;
  /** Subtracted from a message the user phrased as a question (see QUESTION_PENALTY). */
  questionPenalty: number;
}

export const DEFAULT_RECALL_RANKING: RecallRankingOptions = {
  limit: 4,
  minSemantic: 0.5,
  minLexical: 0.5,
  semanticWeight: 0.75,
  margin: 0.05,
  questionPenalty: 0.15,
};

/** Words that carry no topic: question scaffolding and recall verbs, English and Vietnamese. */
const STOPWORDS = new Set(
  (
    'a an the and or but if then so of to in on at by for with about from as is are was were be been being ' +
    'am do does did done have has had having can could would should will shall may might must ' +
    'i me my mine we us our you your yours he she it its they them their this that these those there here ' +
    'what which who whom whose when where why how any some all each every no not yes ok okay ' +
    'remember recall recalled mentioned mention mentions said say says told tell tells ask asked asking ' +
    'earlier before previously previous above ago back last just still ever again also too very much ' +
    'talk talked talking discuss discussed discussing conversation chat message messages thing things ' +
    'please hey hi hello thanks thank like know knew got get one ' +
    'toi minh ban em anh chi ay no la va cua cho voi nhung cac mot nhu khong co da dang se duoc ' +
    'nho nhac noi hoi truoc do day nay kia gi nao sao the nao ma thi cung roi nhe nha a oi'
  ).split(/\s+/),
);

const fold = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

const stem = (token: string): string =>
  token.length > 4 && token.endsWith('ing')
    ? token.slice(0, -3)
    : token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
      ? token.slice(0, -1)
      : token;

/** Content words of a text: folded, split on non-letters, stopwords and 1-character tokens dropped. */
export function recallTokens(text: string): string[] {
  const tokens = fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

/**
 * Share of the question's content words found in the message, each word weighted by
 * how rare it is among the candidates, so a word every message has barely counts.
 */
export function lexicalRecallScores(
  question: string,
  candidates: readonly string[],
): number[] {
  const queryTokens = [...new Set(recallTokens(question))];
  if (queryTokens.length === 0) return candidates.map(() => 0);
  const documents = candidates.map((text) => new Set(recallTokens(text)));
  const weight = (token: string): number => {
    const containing = documents.filter((doc) => doc.has(token)).length;
    return Math.log(1 + (documents.length + 1) / (containing + 1));
  };
  const weights = queryTokens.map(weight);
  const total = weights.reduce((sum, value) => sum + value, 0);
  return documents.map((doc) => {
    const matched = queryTokens.reduce(
      (sum, token, index) => (doc.has(token) ? sum + weights[index] : sum),
      0,
    );
    return total > 0 ? matched / total : 0;
  });
}

/**
 * Which candidates are worth an embedding call: the newest substantive messages the user
 * wrote. Embedding calls are slow (about a second each on the shared service), assistant
 * lines are mostly boilerplate, and a greeting carries nothing to recall. Everything else
 * is still matched by words.
 */
export function selectEmbeddingCandidates(
  candidates: readonly AiChatMessageContext[],
  max: number,
): number[] {
  const seen = new Set<string>();
  const picked: number[] = [];
  for (
    let index = candidates.length - 1;
    index >= 0 && picked.length < max;
    index -= 1
  ) {
    const { role, content } = candidates[index];
    if (role !== 'user' || recallTokens(content).length < 2) continue;
    const key = fold(content).replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(index);
  }
  return picked.sort((left, right) => left - right);
}

/** The question is about a photo the user sent, in English or Vietnamese. */
const PHOTO_QUESTION =
  /\b(photos?|pictures?|pics?|images?|selfies?|screenshots?|hinh|hinh anh|bu?c anh|tam anh)\b/;
const PHOTO_BONUS = 0.2;
/**
 * A user who asked "where am I going?" earlier is closer in meaning to "where did I say I am
 * going?" than the statement that answers it, so earlier questions are demoted (by
 * `questionPenalty`) unless the question itself is about what was asked.
 */
const ASKED_ABOUT = /\b(ask|asked|asking|hoi|question|questions)\b/;
const looksLikeQuestion = (message: AiChatMessageContext): boolean =>
  message.role === 'user' && /[?？]\s*$/.test(message.content.trim());

export const isPhotoQuestion = (question: string): boolean =>
  PHOTO_QUESTION.test(fold(question));

/** Photo messages enter memory as "[Photo] caption shows: description". */
const isPhotoLine = (message: AiChatMessageContext): boolean =>
  message.role === 'user' && message.content.startsWith('[Photo]');

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator > 0 ? dot / denominator : 0;
}

/**
 * `semantic[i]` is the cosine similarity of candidate i to the question, or undefined
 * when no embedding exists for it. The result is the best matches, oldest first.
 */
export function rankRecalledMessages(input: {
  question: string;
  candidates: readonly AiChatMessageContext[];
  semantic?: ReadonlyArray<number | undefined>;
  options?: Partial<RecallRankingOptions>;
}): AiChatMessageContext[] {
  const options = { ...DEFAULT_RECALL_RANKING, ...input.options };
  const lexical = lexicalRecallScores(
    input.question,
    input.candidates.map((candidate) => candidate.content),
  );
  const aboutPhoto = isPhotoQuestion(input.question);
  const aboutAsking = ASKED_ABOUT.test(fold(input.question));
  const scored = input.candidates.map((message, index) => {
    const meaning = input.semantic?.[index];
    const words = lexical[index];
    const photo = aboutPhoto && isPhotoLine(message);
    const relevant =
      photo ||
      (meaning !== undefined && meaning >= options.minSemantic) ||
      words >= options.minLexical;
    const blended =
      meaning === undefined
        ? words
        : options.semanticWeight * Math.max(meaning, 0) +
          (1 - options.semanticWeight) * words;
    const penalty =
      !aboutAsking && !photo && looksLikeQuestion(message)
        ? options.questionPenalty
        : 0;
    return {
      message,
      index,
      relevant,
      score: blended + (photo ? PHOTO_BONUS : 0) - penalty,
    };
  });
  const relevant = scored
    .filter((item) => item.relevant)
    .sort(
      (left, right) => right.score - left.score || right.index - left.index,
    );
  const best = relevant[0]?.score ?? 0;
  return relevant
    .filter((item) => item.score >= best - options.margin)
    .slice(0, options.limit)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.message);
}
