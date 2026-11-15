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

const build = (
  env: Record<string, string>,
  stored: { reusable: boolean } = { reusable: false },
) => {
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
  const checkpoints = {
    initializeAudioSegments: jest.fn(),
    reuseStoredAudioSegments: jest
      .fn()
      .mockResolvedValue(stored.reusable ? 1 : 0),
    // After a successful reuse the segment is already COMPLETED in this attempt.
    listAudioSegments: jest
      .fn()
      .mockResolvedValue([
        stored.reusable
          ? { ...pendingSegment, status: 'COMPLETED' }
          : pendingSegment,
      ]),
    markAudioSegmentProcessing: jest.fn(),
    completeAudioSegment: jest.fn(),
    failAudioSegment: jest.fn(),
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
    checkpoints as never,
  );
  return { useCase, ai, checkpoints };
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

describe('TranscribeAudioManifestUseCase stored transcripts', () => {
  const visualRerun = { ...job, requireVisualAnalysis: true } as ReelIndexJob;

  it('reuses the stored transcript instead of calling Whisper on a visual re-analysis run', async () => {
    const { useCase, ai, checkpoints } = build({}, { reusable: true });
    await useCase.execute(visualRerun);
    expect(checkpoints.reuseStoredAudioSegments).toHaveBeenCalledWith({
      reelId: 'reel-1',
      indexAttemptId: 'attempt-1',
    });
    expect(ai.transcribeAudioKey).not.toHaveBeenCalled();
  });

  it('still transcribes a visual re-analysis run when no transcript is stored', async () => {
    const { useCase, ai } = build({}, { reusable: false });
    await useCase.execute(visualRerun);
    expect(ai.transcribeAudioKey).toHaveBeenCalledTimes(1);
  });

  it('never reuses a stored transcript for a normal index job', async () => {
    const { useCase, checkpoints } = build({}, { reusable: true });
    await useCase.execute(job);
    expect(checkpoints.reuseStoredAudioSegments).not.toHaveBeenCalled();
  });
});
