import type { TranslateSubtitleCuesRequest } from '@common/ai/interfaces/subtitle-translation.interface';
import { Test } from '@nestjs/testing';
import { ReelSubtitleTranslator } from '../services/reel-subtitle-translator.service';
import { CompleteReelIndexingUseCase } from './complete-reel-indexing.use-case';
import { PreTranslateReelSubtitlesUseCase } from './pre-translate-reel-subtitles.use-case';
import { UpdateReelStatusUseCase } from './update-reel-status.use-case';

const targets = (mock: jest.Mock) =>
  (mock.mock.calls as [TranslateSubtitleCuesRequest][]).map(
    ([request]) => request.targetLanguage,
  );

const reelWithTranscript = {
  id: 'reel-1',
  title: 'Episode 1',
  transcriptSegments: [
    { text: '我是', start: 1.8, end: 1.9 },
    { text: '定北王', start: 1.9, end: 2.4 },
  ],
};

async function compile() {
  const translate = jest.fn().mockResolvedValue({
    model: 'm1',
    cues: [{ index: 0, text: 'Tôi là Định Bắc Vương' }],
  });
  const repository = {
    completeIndexing: jest.fn().mockResolvedValue(true),
    updateReelStatus: jest.fn().mockResolvedValue({ id: 'reel-1' }),
    findById: jest.fn().mockResolvedValue(reelWithTranscript),
  };
  const module = await Test.createTestingModule({
    providers: [
      ReelSubtitleTranslator,
      PreTranslateReelSubtitlesUseCase,
      CompleteReelIndexingUseCase,
      UpdateReelStatusUseCase,
      { provide: 'IContentRepository', useValue: repository },
      {
        provide: 'IReelSubtitleTrackRepository',
        useValue: {
          find: jest.fn().mockResolvedValue(null),
          save: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: 'ISubtitleTranslationService', useValue: { translate } },
    ],
  }).compile();
  return { module, translate, repository };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('subtitle pre-translation wiring', () => {
  it('resolves its dependencies with the real providers', async () => {
    const { module } = await compile();
    expect(module.get(CompleteReelIndexingUseCase)).toBeInstanceOf(
      CompleteReelIndexingUseCase,
    );
    expect(module.get(UpdateReelStatusUseCase)).toBeInstanceOf(
      UpdateReelStatusUseCase,
    );
  });

  it('starts pre-translation once indexing stored a transcript, and not before it is applied', async () => {
    const { module, translate, repository } = await compile();
    const indexing = module.get(CompleteReelIndexingUseCase);
    const command = {
      reelId: 'reel-1',
      indexAttemptId: 'attempt',
      transcriptSegments: reelWithTranscript.transcriptSegments,
    } as never;

    repository.completeIndexing.mockResolvedValueOnce(false);
    await indexing.execute(command);
    await flush();
    expect(translate).not.toHaveBeenCalled();

    await indexing.execute(command);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(targets(translate)).toEqual(['vi', 'en']);
  });
});
