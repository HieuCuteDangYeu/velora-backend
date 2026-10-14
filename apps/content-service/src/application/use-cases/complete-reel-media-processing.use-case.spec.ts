import { CompleteReelMediaProcessingUseCase } from './complete-reel-media-processing.use-case';

describe('CompleteReelMediaProcessingUseCase', () => {
  const input = {
    reelId: 'reel-1',
    mediaAttemptId: 'media-attempt-1',
    mediaMetadata: { sourceDurationMs: 90_000, sourceOrientation: 'LANDSCAPE' },
    mediaOutput: {
      thumbnailKey: 'reels/reel-1/thumbnail.jpg',
      hlsMasterKey: 'reels/reel-1/master.m3u8',
      sourceHasAudio: true,
      sourceLengthClass: 'SHORT',
    },
  } as any;

  it('triggers the dispatcher once after media completion commits', async () => {
    const completeMediaProcessing = jest.fn().mockResolvedValue(true);
    const trigger = jest.fn();
    const useCase = new CompleteReelMediaProcessingUseCase(
      { completeMediaProcessing } as any,
      { trigger },
    );

    await expect(useCase.execute(input)).resolves.toBe(true);

    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('does not trigger when the completion was not applied', async () => {
    const trigger = jest.fn();
    const useCase = new CompleteReelMediaProcessingUseCase(
      { completeMediaProcessing: jest.fn().mockResolvedValue(false) } as any,
      { trigger },
    );

    await expect(useCase.execute(input)).resolves.toBe(false);

    expect(trigger).not.toHaveBeenCalled();
  });
});
