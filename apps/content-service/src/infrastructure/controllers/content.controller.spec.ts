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

describe('ContentController reel series dispatch', () => {
  it.each([
    {
      dependency: 'createReelSeriesUseCase',
      call: (controller: ContentController) =>
        controller.createReelSeries({
          ownerId: ' user-1 ',
          payload: { title: 'Series' },
        }),
      args: ['user-1', { title: 'Series', visibility: 'public' }],
    },
    {
      dependency: 'listOwnedReelSeriesUseCase',
      call: (controller: ContentController) =>
        controller.listOwnedReelSeries({
          ownerId: ' user-1 ',
          query: { limit: 12 },
        }),
      args: ['user-1', { limit: 12 }],
    },
    {
      dependency: 'getReelSeriesEpisodesUseCase',
      call: (controller: ContentController) =>
        controller.getReelSeriesEpisodes({
          seriesId: ' series-1 ',
          viewerId: ' user-1 ',
          query: { limit: 15 },
        }),
      args: ['series-1', 'user-1', false, { limit: 15 }],
    },
    {
      dependency: 'getReelSeriesUseCase',
      call: (controller: ContentController) =>
        controller.getReelSeries({
          seriesId: ' series-1 ',
          viewerId: ' user-1 ',
          isAdmin: true,
        }),
      args: ['series-1', 'user-1', true],
    },
    {
      dependency: 'listReelSeriesCandidatesUseCase',
      call: (controller: ContentController) =>
        controller.listReelSeriesCandidates({
          seriesId: ' series-1 ',
          ownerId: ' user-1 ',
          query: { limit: 12 },
        }),
      args: ['series-1', 'user-1', { limit: 12 }],
    },
    {
      dependency: 'updateReelSeriesUseCase',
      call: (controller: ContentController) =>
        controller.updateReelSeries({
          seriesId: ' series-1 ',
          ownerId: ' user-1 ',
          payload: { title: 'Updated' },
        }),
      args: ['series-1', 'user-1', { title: 'Updated' }],
    },
    {
      dependency: 'deleteReelSeriesUseCase',
      call: (controller: ContentController) =>
        controller.deleteReelSeries({
          seriesId: ' series-1 ',
          ownerId: ' user-1 ',
        }),
      args: ['series-1', 'user-1'],
    },
    {
      dependency: 'addReelsToSeriesUseCase',
      call: (controller: ContentController) =>
        controller.addReelToSeries({
          seriesId: ' series-1 ',
          ownerId: ' user-1 ',
          payload: { reelIds: ['reel-1'] },
        }),
      args: ['series-1', 'user-1', { reelIds: ['reel-1'] }],
    },
    {
      dependency: 'removeReelFromSeriesUseCase',
      call: (controller: ContentController) =>
        controller.removeReelFromSeries({
          seriesId: ' series-1 ',
          reelId: ' reel-1 ',
          ownerId: ' user-1 ',
        }),
      args: ['series-1', 'reel-1', 'user-1'],
    },
    {
      dependency: 'reorderReelSeriesUseCase',
      call: (controller: ContentController) =>
        controller.reorderReelSeries({
          seriesId: ' series-1 ',
          ownerId: ' user-1 ',
          payload: { reelIds: ['reel-1'] },
        }),
      args: ['series-1', 'user-1', { reelIds: ['reel-1'] }],
    },
  ])(
    'dispatches $dependency to execute with validated inputs',
    async ({ dependency, call, args }) => {
      const execute = jest.fn().mockResolvedValue({
        items: [],
        series: {},
        previousCursor: null,
        nextCursor: null,
      });
      const controller = {
        [dependency]: { execute },
        toReelSeriesSerializable: jest.fn(),
        toReelSeriesMetadataSerializable: jest.fn(),
        serializeEpisodeCursor: jest.fn(),
        serializeCursor: jest.fn(),
      } as unknown as ContentController;
      Object.setPrototypeOf(controller, ContentController.prototype);
      await call(controller);
      expect(execute).toHaveBeenCalledWith(...args);
    },
  );
});
