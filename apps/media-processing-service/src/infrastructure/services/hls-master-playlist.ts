/**
 * AVPlayer starts on the first variant listed in a master playlist and only climbs the ladder
 * after measuring a few segments, while ffmpeg writes the variants lowest first. Short reels
 * (and iOS warm players buffering ahead while paused) therefore played mostly at 360p on iOS
 * even though a 720p rung existed. Listing the highest bandwidth first makes iOS start at the
 * best rung and step down only when the network cannot sustain it. ExoPlayer chooses by its own
 * bandwidth estimate, so the order does not change Android playback.
 *
 * Returns the playlist unchanged when it does not look like a plain master playlist.
 */
export function orderHlsMasterVariantsHighestFirst(playlist: string): string {
  const lines = playlist.split(/\r?\n/);
  const header: string[] = [];
  const variants: Array<{ bandwidth: number; lines: string[] }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line.startsWith('#EXT-X-STREAM-INF:')) {
      if (line.length > 0 && !line.startsWith('#')) {
        // A URI that does not follow a STREAM-INF tag: not a layout this helper understands.
        return playlist;
      }
      if (line.length > 0) {
        header.push(line);
      }
      continue;
    }

    const bandwidth = Number(/(?:^|[:,])BANDWIDTH=(\d+)/.exec(line)?.[1]);
    let uriIndex = index + 1;
    while (uriIndex < lines.length && lines[uriIndex].trim().length === 0) {
      uriIndex += 1;
    }
    const uri = lines[uriIndex]?.trim();

    if (!Number.isFinite(bandwidth) || !uri || uri.startsWith('#')) {
      return playlist;
    }

    variants.push({ bandwidth, lines: [line, uri] });
    index = uriIndex;
  }

  if (variants.length < 2) {
    return playlist;
  }

  const ordered = variants
    .map((variant, position) => ({ ...variant, position }))
    .sort((a, b) => b.bandwidth - a.bandwidth || a.position - b.position);

  return `${[...header, ...ordered.flatMap((variant) => [...variant.lines, ''])].join('\n').trimEnd()}\n`;
}
