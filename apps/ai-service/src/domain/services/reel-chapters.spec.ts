import {
  chapterRangeQuestion,
  matchChapterTitle,
  parseDescriptionChapters,
} from './reel-chapters';
import { isTimeRangeSummaryQuestion } from './rag-prompt-bounds';
import { matchTranscriptTimestamp } from './rag-source-retrieval-plan';

const description = [
  'Le boeuf bourguignon authentique',
  '',
  '0:00 Intro',
  '1:05 Les ingrédients',
  '3:20 - La cuisson',
  '(8:45) Dressage et dégustation',
].join('\n');

describe('parseDescriptionChapters', () => {
  it('reads timestamped lines in the formats creators use', () => {
    expect(parseDescriptionChapters(description)).toEqual([
      { startSec: 0, title: 'Intro' },
      { startSec: 65, title: 'Les ingrédients' },
      { startSec: 200, title: 'La cuisson' },
      { startSec: 525, title: 'Dressage et dégustation' },
    ]);
    expect(parseDescriptionChapters('1:02:03 Long part\n1:30:00 Next')).toEqual(
      [
        { startSec: 3723, title: 'Long part' },
        { startSec: 5400, title: 'Next' },
      ],
    );
  });

  it.each([
    ['nothing', undefined],
    ['text without timestamps', 'A video about cooking.'],
    ['a single timestamp', 'Watch from 2:30 Great part'],
    ['timestamps that go backwards', '0:00 A\n5:00 B\n2:00 C'],
  ])('is not a chapter list for %s', (_name, value) => {
    expect(parseDescriptionChapters(value)).toEqual([]);
  });
});

describe('matchChapterTitle', () => {
  const chapters = parseDescriptionChapters(description);

  it('finds the chapter a question names, ignoring accents and case, and ends it at the next chapter', () => {
    const match = matchChapterTitle(
      'What is covered in the part of the video titled "Les ingredients"?',
      chapters,
    );
    expect(match?.chapter.title).toBe('Les ingrédients');
    expect(match?.endSec).toBe(200);
  });

  it('ends the last chapter at the video duration, or after five minutes when unknown', () => {
    const question = 'What happens in "Dressage et dégustation"?';
    expect(matchChapterTitle(question, chapters, 700)?.endSec).toBe(700);
    expect(matchChapterTitle(question, chapters)?.endSec).toBe(825);
  });

  it('only matches a single-word title when it is quoted', () => {
    expect(
      matchChapterTitle('Give me the intro of this video', chapters),
    ).toBeUndefined();
    expect(
      matchChapterTitle('What is in the part titled "Intro"?', chapters)
        ?.chapter.title,
    ).toBe('Intro');
  });

  it('returns nothing when no title appears or there are no chapters', () => {
    expect(
      matchChapterTitle('How hot should the oven be?', chapters),
    ).toBeUndefined();
    expect(matchChapterTitle('anything "Intro"', [])).toBeUndefined();
  });

  it('prefers the longest matching title', () => {
    const nested = parseDescriptionChapters(
      '0:00 Setup steps\n2:00 Setup steps for beginners\n5:00 End',
    );
    expect(
      matchChapterTitle('What about the setup steps for beginners?', nested)
        ?.chapter.startSec,
    ).toBe(120);
  });
});

describe('chapterRangeQuestion', () => {
  it('is recognised by the existing time-range summary rules', () => {
    const question = chapterRangeQuestion({
      chapter: { startSec: 65, title: 'Les ingrédients' },
      endSec: 200,
    });
    expect(question).toContain('from 65 to 200 seconds');
    expect(isTimeRangeSummaryQuestion(question)).toBe(true);
    expect(matchTranscriptTimestamp(question)).toEqual([
      expect.any(String),
      '65',
      '200',
    ]);
  });
});
