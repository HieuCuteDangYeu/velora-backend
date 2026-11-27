/**
 * Index chunks overlap and run up to ~45 s, so a read of "0:00 to 0:39" returns a chunk that goes on to 1:02 and the
 * answer summarizes speech outside the window. Chunks carry only their start and end, so the time of each sentence
 * is estimated from its position in the text (speech rate taken as even across the chunk), and only sentences whose
 * middle falls inside the window are kept. Text that lies wholly inside the window is returned unchanged.
 */
export function trimTranscriptToWindow(
  text: string,
  chunkStart: number,
  chunkEnd: number,
  windowStart: number,
  windowEnd: number,
): string {
  if (
    !text ||
    !(chunkEnd > chunkStart) ||
    (chunkStart >= windowStart && chunkEnd <= windowEnd)
  )
    return text;
  const sentences = text.match(/[^.!?。！？]+(?:[.!?。！？]+["')\]]*|$)\s*/g);
  const parts =
    sentences && sentences.length >= 2
      ? sentences
      : (text.match(/\S+\s*/g) ?? [text]);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const seconds = chunkEnd - chunkStart;
  let offset = 0;
  const timed = parts.map((part) => {
    const middle = chunkStart + ((offset + part.length / 2) / total) * seconds;
    offset += part.length;
    return { part, middle };
  });
  const kept = timed.filter(
    ({ middle }) => middle >= windowStart && middle <= windowEnd,
  );
  if (kept.length === 0) {
    const nearest = timed.reduce((best, item) =>
      distanceToWindow(item.middle, windowStart, windowEnd) <
      distanceToWindow(best.middle, windowStart, windowEnd)
        ? item
        : best,
    );
    return nearest.part.trim();
  }
  return kept
    .map(({ part }) => part)
    .join('')
    .trim();
}

function distanceToWindow(time: number, start: number, end: number): number {
  return time < start ? start - time : time > end ? time - end : 0;
}
