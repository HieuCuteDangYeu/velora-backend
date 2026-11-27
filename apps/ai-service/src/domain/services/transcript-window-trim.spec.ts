import { trimTranscriptToWindow } from './transcript-window-trim';

describe('trimTranscriptToWindow', () => {
  const text =
    'First we greet everyone. Then the weather in Europe. Now we are in Greece. This is the parliament square.';

  it('returns text wholly inside the window unchanged', () => {
    expect(trimTranscriptToWindow(text, 10, 30, 0, 39)).toBe(text);
  });

  it('drops the sentences spoken after the window ends', () => {
    // 0-60 s chunk, window ends at 39 s: the last sentence (middle ~52 s) is outside
    expect(trimTranscriptToWindow(text, 0, 60, 0, 39)).toBe(
      'First we greet everyone. Then the weather in Europe. Now we are in Greece.',
    );
  });

  it('drops the sentences spoken before the window starts', () => {
    expect(trimTranscriptToWindow(text, 0, 60, 30, 90)).toBe(
      'Now we are in Greece. This is the parliament square.',
    );
  });

  it('falls back to words when the chunk has no sentence breaks', () => {
    expect(
      trimTranscriptToWindow('one two three four five six', 0, 60, 0, 30),
    ).toBe('one two three');
  });

  it('keeps the nearest sentence rather than nothing', () => {
    expect(
      trimTranscriptToWindow(
        'Short. A much longer second sentence here.',
        0,
        10,
        0,
        0.1,
      ),
    ).toBe('Short.');
  });
});
