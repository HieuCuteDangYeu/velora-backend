export interface ReelChapter {
  startSec: number;
  title: string;
}

export interface ChapterMatch {
  chapter: ReelChapter;
  endSec: number;
}

// "0:00 Intro", "00:00 - Intro", "(1:02:03) Title", "1:02 – Title"
const CHAPTER_LINE =
  /^\s*[([]?(\d{1,2}(?::\d{2}){1,2})[)\]]?\s*[-–—:.)]*\s*(.+?)\s*$/u;
const LAST_CHAPTER_DEFAULT_SECONDS = 300;
const MIN_CHAPTERS = 2;
const MIN_PLAIN_TITLE_CHARS = 8;

const clockToSeconds = (clock: string): number =>
  clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);

/** Lowercase, without accents or punctuation, so "Quartier d'été" matches "quartier d ete". */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Chapters the way YouTube defines them: lines of the description that start with a timestamp, in increasing
 * order. Fewer than two (or a list that goes backwards) is not a chapter list.
 */
export function parseDescriptionChapters(
  description: string | undefined | null,
): ReelChapter[] {
  if (!description) return [];
  const chapters: ReelChapter[] = [];
  for (const line of description.split(/\r?\n/)) {
    const match = CHAPTER_LINE.exec(line);
    if (!match) continue;
    const title = match[2].trim();
    if (!title) continue;
    chapters.push({ startSec: clockToSeconds(match[1]), title });
  }
  if (chapters.length < MIN_CHAPTERS) return [];
  for (let i = 1; i < chapters.length; i += 1) {
    if (chapters[i].startSec <= chapters[i - 1].startSec) return [];
  }
  return chapters;
}

/**
 * The chapter a question names, or undefined. A title must appear in the question (accents and case ignored);
 * a short or single-word title ("Intro") only counts when it is quoted, so ordinary words do not match.
 */
export function matchChapterTitle(
  question: string,
  chapters: ReelChapter[],
  durationSec?: number,
): ChapterMatch | undefined {
  if (chapters.length === 0) return undefined;
  const normalizedQuestion = ` ${normalizeForMatch(question)} `;
  const quoted = [
    ...question.matchAll(/["“”«»'‘’]([^"“”«»'‘’]{2,80})["“”«»'‘’]/gu),
  ].map((match) => normalizeForMatch(match[1]));
  let best: { index: number; length: number } | undefined;
  chapters.forEach((chapter, index) => {
    const title = normalizeForMatch(chapter.title);
    if (!title) return;
    const plain = title.length >= MIN_PLAIN_TITLE_CHARS && title.includes(' ');
    const present = normalizedQuestion.includes(` ${title} `);
    if (!(present && (plain || quoted.includes(title)))) return;
    if (!best || title.length > best.length)
      best = { index, length: title.length };
  });
  if (!best) return undefined;
  const chapter = chapters[best.index];
  const next = chapters[best.index + 1];
  const endSec =
    next?.startSec ??
    (durationSec !== undefined && durationSec > chapter.startSec
      ? durationSec
      : chapter.startSec + LAST_CHAPTER_DEFAULT_SECONDS);
  return { chapter, endSec: Math.round(endSec) };
}

/** The question rewritten into the time-range summary form the rest of the pipeline already answers well. */
export function chapterRangeQuestion(match: ChapterMatch): string {
  return `Summarize what is said from ${Math.round(match.chapter.startSec)} to ${match.endSec} seconds in the video, in the part titled "${match.chapter.title}".`;
}
