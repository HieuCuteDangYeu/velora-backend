import { isSpeechlessAudio } from './reel-index-langgraph.workflow';

describe('isSpeechlessAudio', () => {
  const segment = (status: string, transcriptText?: string) =>
    ({ status, transcriptText }) as never;

  it('is true when every segment was transcribed and came back empty', () => {
    expect(
      isSpeechlessAudio([segment('COMPLETED', ''), segment('COMPLETED', '  ')]),
    ).toBe(true);
    expect(isSpeechlessAudio([segment('COMPLETED')])).toBe(true);
  });

  it('is false when any segment holds speech', () => {
    expect(
      isSpeechlessAudio([segment('COMPLETED', ''), segment('COMPLETED', 'hi')]),
    ).toBe(false);
  });

  it('is false when a segment failed or never ran, so a broken transcription still fails', () => {
    expect(
      isSpeechlessAudio([segment('COMPLETED', ''), segment('FAILED')]),
    ).toBe(false);
    expect(isSpeechlessAudio([segment('PENDING')])).toBe(false);
    expect(isSpeechlessAudio([segment('PROCESSING', '')])).toBe(false);
  });

  it('is false with no segments at all', () => {
    expect(isSpeechlessAudio([])).toBe(false);
  });
});
