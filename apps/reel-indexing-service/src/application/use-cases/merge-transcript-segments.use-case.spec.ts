import { MergeTranscriptSegmentsUseCase } from './merge-transcript-segments.use-case';

describe('MergeTranscriptSegmentsUseCase', () => {
  it('clamps provider timestamps to the audio artifact bounds', () => {
    const result = new MergeTranscriptSegmentsUseCase().execute(
      [
        {
          indexAttemptId: 'attempt-1',
          segmentNumber: 0,
          artifactKey: 'audio.wav',
          artifactChecksum: 'checksum',
          startMs: 0,
          endMs: 10_000,
          overlapBeforeMs: 0,
          status: 'COMPLETED',
          attemptCount: 1,
          transcriptText: 'hello',
          transcriptSegments: [
            { start: 9, end: 30, text: 'hello', id: 0 },
          ],
        },
      ],
      1,
    );

    expect(result.segments).toEqual([
      expect.objectContaining({ start: 9, end: 10 }),
    ]);
  });
});
