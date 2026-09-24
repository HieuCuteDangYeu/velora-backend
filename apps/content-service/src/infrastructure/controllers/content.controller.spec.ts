import { ContentController } from './content.controller';

describe('ContentController existing HLS evidence', () => {
  it('maps the processing attempt wire field to the content media attempt', async () => {
    const execute = jest.fn().mockResolvedValue(true);
    const mediaMetadata = {
      sourceDurationMs: 105_000,
      sourceOrientation: 'PORTRAIT',
      sourceLengthClass: 'SHORT',
      sourceHasAudio: true,
    };

    const result =
      await ContentController.prototype.persistExistingHlsEvidence.call(
        { completeExistingHlsEvidenceUseCase: { execute } } as any,
        {
          reelId: 'reel-1',
          processingAttemptId: 'media-attempt-1',
          transcriptionAudioManifestKey: 'reels/reel-1/audio.json',
          visualFrameManifestKey: 'reels/reel-1/visual.json',
          mediaMetadata: mediaMetadata as any,
        },
      );

    expect(execute).toHaveBeenCalledWith({
      reelId: 'reel-1',
      mediaAttemptId: 'media-attempt-1',
      transcriptionAudioManifestKey: 'reels/reel-1/audio.json',
      visualFrameManifestKey: 'reels/reel-1/visual.json',
      mediaMetadata,
    });
    expect(result).toEqual({ persisted: true, applied: true });
  });
});
