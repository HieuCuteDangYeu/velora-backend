import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { AudioSegmentCheckpoint } from '@indexing/domain/entities/index-checkpoint.entity';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { TranscribeAudioManifestUseCase } from './transcribe-audio-manifest.use-case';

const job = {
  reelId: 'reel-1',
  mediaAttemptId: 'media-1',
  indexAttemptId: 'attempt-1',
  indexVersion: 'index-v1',
  transcriptionAudioManifestKey: 'manifest.json',
  title: 'The Secret Behind My Scoundrel Husband Episode 5',
  description: 'Claire Wynn, a noble princess, chose an honest scholar.',
  tags: ['narto-drama', 'short-drama'],
} as ReelIndexJob;

const pendingSegment = {
  segmentNumber: 0,
  artifactKey: 'audio_000000.wav',
  status: 'PENDING',
  attemptCount: 0,
} as AudioSegmentCheckpoint;

const build = (env: Record<string, string>) => {
  const config: IIndexingApplicationConfig = {
    get: <T = string>(key: string) => env[key] as T | undefined,
    transcriptionIdentity: () => ({
      provider: 'groq',
      model: 'whisper',
      version: 'v1',
    }),
    embeddingIdentity: () => ({
      model: 'BAAI/bge-m3',
      dimensions: 1024,
      version: 'v1',
    }),
  };
  const ai = {
    transcribeAudioKey: jest.fn().mockResolvedValue({ text: 'hello' }),
  };
  const useCase = new TranscribeAudioManifestUseCase(
    config,
    {
      getTranscriptionAudioManifest: jest.fn().mockResolvedValue({
        reelId: 'reel-1',
        mediaAttemptId: 'media-1',
        artifacts: [{ checksum: 'c' }],
      }),
    } as never,
    ai as never,
    {
      initializeAudioSegments: jest.fn(),
      listAudioSegments: jest.fn().mockResolvedValue([pendingSegment]),
      markAudioSegmentProcessing: jest.fn(),
      completeAudioSegment: jest.fn(),
      failAudioSegment: jest.fn(),
    } as never,
  );
  return { useCase, ai };
};

describe('TranscribeAudioManifestUseCase metadata prompt', () => {
  it('does not send the English metadata prompt to Whisper by default', async () => {
    const { useCase, ai } = build({});
    await useCase.execute(job);
    expect(ai.transcribeAudioKey).toHaveBeenCalledWith({
      audioKey: 'audio_000000.wav',
      initialPrompt: undefined,
    });
  });

  it('sends the title, description and tags only when explicitly enabled', async () => {
    const { useCase, ai } = build({
      INDEX_TRANSCRIPTION_METADATA_PROMPT: 'true',
    });
    await useCase.execute(job);
    expect(ai.transcribeAudioKey).toHaveBeenCalledWith({
      audioKey: 'audio_000000.wav',
      initialPrompt: expect.stringContaining('narto-drama'),
    });
  });
});
