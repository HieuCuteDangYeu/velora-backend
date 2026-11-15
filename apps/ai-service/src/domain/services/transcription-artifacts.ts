// Whisper invents a few stock phrases when it hears music or silence, and
// sometimes loops on one word. Neither was spoken, so neither belongs in the
// transcript that gets chunked, embedded and quoted back to users.
//
// Only the credit line seen in practice is listed. Quality scores from the
// model (no_speech_prob, avg_logprob) were checked and cannot be used instead:
// no_speech_prob is 0 for these segments and avg_logprob is just as low for
// genuine traditional-Chinese speech as for the invented text.
const CREDIT_PHRASE =
  /(?:请不吝|請不吝|请|請)?[点點][赞贊][订訂][阅閱][转轉][发發](?:[订訂][阅閱][转轉][发發])*(?:打[赏賞])?(?:支持)?(?:明[镜鏡])?(?:[与與][点點]{1,2})?(?:栏目|欄目)?|打[赏賞]支持明[镜鏡](?:[与與][点點]{1,2})?(?:栏目|欄目)?/gu;

const MIN_LOOP_RUN = 8;

export interface TimedTranscriptItem {
  start: number;
  end: number;
  text: string;
  id?: number;
}

export function stripTranscriptionArtifactsFromText(text: string): string {
  return text.replace(CREDIT_PHRASE, ' ').replace(/\s+/gu, ' ').trim();
}

// Removes the stock credit phrase character by character, so an item that
// holds real speech next to the phrase keeps the real speech and its timing.
function removeCreditPhrase<T extends TimedTranscriptItem>(items: T[]): T[] {
  const joined = items.map((item) => item.text).join('');
  const removed = new Array<boolean>(joined.length).fill(false);
  for (const match of joined.matchAll(CREDIT_PHRASE)) {
    const from = match.index ?? 0;
    for (let i = from; i < from + match[0].length; i += 1) removed[i] = true;
  }
  if (!removed.includes(true)) return items;

  const kept: T[] = [];
  let offset = 0;
  for (const item of items) {
    const text = Array.from(item.text)
      .map((char, i) => (removed[offset + i] ? '' : char))
      .join('')
      .trim();
    offset += item.text.length;
    if (text) kept.push({ ...item, text });
  }
  return kept;
}

// A run of the same token repeated eight or more times back to back is a decoding loop (shorter runs are stutters and emphasis). Keep one.
function collapseLoops<T extends TimedTranscriptItem>(items: T[]): T[] {
  const kept: T[] = [];
  for (let i = 0; i < items.length; ) {
    let end = i + 1;
    while (end < items.length && items[end].text === items[i].text) end += 1;
    if (end - i >= MIN_LOOP_RUN) {
      kept.push({ ...items[i], end: items[end - 1].end });
    } else {
      kept.push(...items.slice(i, end));
    }
    i = end;
  }
  return kept;
}

export function removeTranscriptionArtifacts<T extends TimedTranscriptItem>(
  items: T[],
): T[] {
  return collapseLoops(removeCreditPhrase(items)).map((item, index) => ({
    ...item,
    id: index,
  }));
}
