import type { IVisionService } from '@ai/domain/interfaces/vision.service.interface';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FallbackVisionAdapter } from './fallback-vision.adapter';

const frame = { image: new Uint8Array([1]), mimeType: 'image/jpeg' as const };
const analysis = (provider: string) => ({
  caption: 'A room.',
  objects: [],
  provider,
  model: 'm',
  version: 'v',
});

function build(
  primary: IVisionService,
  secondary: IVisionService,
  now = () => 1_000,
) {
  return new FallbackVisionAdapter(
    {} as ConfigService,
    primary,
    secondary,
    now,
  );
}

describe('FallbackVisionAdapter', () => {
  it('uses the primary provider when it works', async () => {
    const primary = {
      analyzeImage: jest.fn().mockResolvedValue(analysis('cf')),
    };
    const secondary = { analyzeImage: jest.fn() };
    await expect(
      build(primary, secondary).analyzeImage(frame),
    ).resolves.toMatchObject({ provider: 'cf' });
    expect(secondary.analyzeImage).not.toHaveBeenCalled();
  });

  it('falls back on a rate-limit error', async () => {
    const primary = {
      analyzeImage: jest
        .fn()
        .mockRejectedValue(new Error('request failed with status 429')),
    };
    const secondary = {
      analyzeImage: jest.fn().mockResolvedValue(analysis('groq')),
    };
    await expect(
      build(primary, secondary).analyzeImage(frame),
    ).resolves.toMatchObject({ provider: 'groq' });
  });

  it('does not mask non-quota failures', async () => {
    const failure = new Error('invalid structured JSON');
    const primary = { analyzeImage: jest.fn().mockRejectedValue(failure) };
    const secondary = { analyzeImage: jest.fn() };
    await expect(build(primary, secondary).analyzeImage(frame)).rejects.toBe(
      failure,
    );
    expect(secondary.analyzeImage).not.toHaveBeenCalled();
  });

  it('skips the primary until the next UTC midnight once the daily allocation is spent', async () => {
    let now = Date.UTC(2026, 10, 6, 10, 0, 0);
    const primary = {
      analyzeImage: jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'you have used up your daily free allocation of 10,000 neurons',
          ),
        )
        .mockResolvedValue(analysis('cf')),
    };
    const secondary = {
      analyzeImage: jest.fn().mockResolvedValue(analysis('groq')),
    };
    const adapter = build(primary, secondary, () => now);

    await adapter.analyzeImage(frame);
    await adapter.analyzeImage(frame);
    expect(primary.analyzeImage).toHaveBeenCalledTimes(1);
    expect(secondary.analyzeImage).toHaveBeenCalledTimes(2);

    now = Date.UTC(2026, 10, 7, 0, 0, 1);
    await expect(adapter.analyzeImage(frame)).resolves.toMatchObject({
      provider: 'cf',
    });
    expect(primary.analyzeImage).toHaveBeenCalledTimes(2);
  });

  it('is constructible through Nest dependency injection with only ConfigService', async () => {
    const values: Record<string, string> = {
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'token',
      AI_VISION_MODEL: 'model',
      AI_VISION_VERSION: 'version',
      AI_VISION_TIMEOUT_MS: '30000',
      GROQ_API_KEYS: 'key-a',
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FallbackVisionAdapter,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => values[key],
            getOrThrow: (key: string) => {
              if (!(key in values)) throw new Error(`missing ${key}`);
              return values[key];
            },
          },
        },
      ],
    }).compile();
    expect(moduleRef.get(FallbackVisionAdapter)).toBeInstanceOf(
      FallbackVisionAdapter,
    );
  });
});
