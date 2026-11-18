import { ChatImageUnreadableError } from '@ai/domain/errors/chat-image-unreadable.error';
import { CloudflareVisionAdapter } from '@ai/infrastructure/adapters/cloudflare-vision.adapter';
import { FallbackVisionAdapter } from '@ai/infrastructure/adapters/fallback-vision.adapter';
import { GroqVisionAdapter } from '@ai/infrastructure/adapters/groq-vision.adapter';
import { R2ChatImageStorageService } from '@ai/infrastructure/services/r2-chat-image-storage.service';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DescribeChatImagesUseCase } from './describe-chat-images.use-case';
import { RefuseRagInputUseCase } from './refuse-rag-input.use-case';

/**
 * Opt-in: reads the real provider settings from .env and makes real calls with a synthetic
 * picture (no user data). Uses the vision provider the module would pick, and the real R2
 * client on a key that does not exist, so no stored object is read or written.
 *
 *   CHAT_IMAGE_LIVE=1 CHAT_IMAGE_LIVE_FILE=/path/to/picture.jpg \
 *     npx jest describe-chat-images.live.integration
 */
const liveIt = process.env.CHAT_IMAGE_LIVE === '1' ? it : it.skip;

describe('chat image understanding against the real providers (opt-in)', () => {
  jest.setTimeout(180_000);

  liveIt(
    'describes a picture with the configured vision provider',
    async () => {
      loadEnv({ path: `${process.cwd()}/.env` });
      const config = new ConfigService(process.env);
      const vision =
        process.env.AI_VISION_PROVIDER === 'groq'
          ? new GroqVisionAdapter(config)
          : process.env.AI_VISION_FALLBACK_PROVIDER === 'groq'
            ? new FallbackVisionAdapter(config)
            : new CloudflareVisionAdapter(config);
      const bytes = readFileSync(process.env.CHAT_IMAGE_LIVE_FILE as string);
      const userId = 'live-check-user';
      const key = `chat-images/${userId}/${randomUUID()}.jpeg`;
      const appConfig = { get: () => undefined };
      const useCase = new DescribeChatImagesUseCase(
        { downloadImage: jest.fn().mockResolvedValue(bytes) },
        vision,
        appConfig as never,
        new RefuseRagInputUseCase(appConfig as never),
      );

      const started = Date.now();
      const [context] = await useCase.execute({
        userId,
        images: [{ fileKey: key, mimeType: 'image/jpeg' }],
      });
      console.log(
        `[live vision] provider=${vision.constructor.name} ms=${Date.now() - started}\n${JSON.stringify(context)}`,
      );

      expect(context.description.length).toBeGreaterThan(10);
      expect(
        `${context.description} ${context.ocrText ?? ''} ${context.objects.join(' ')}`,
      ).toMatch(/bike|bicycle|cycl/i);
    },
  );

  liveIt(
    'reports a missing R2 object as unreadable, not as a crash',
    async () => {
      loadEnv({ path: `${process.cwd()}/.env` });
      const storage = new R2ChatImageStorageService(
        new ConfigService(process.env),
      );

      await expect(
        storage.downloadImage(
          `chat-images/live-check-user/${randomUUID()}.jpeg`,
          4 * 1024 * 1024,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'IMAGE_UNREADABLE',
          reason: 'NOT_FOUND',
        }),
      );
      expect(ChatImageUnreadableError).toBeDefined();
    },
  );

  // Writes one synthetic object to the configured bucket and always deletes it.
  const writeIt =
    process.env.CHAT_IMAGE_LIVE === '1' &&
    process.env.CHAT_IMAGE_R2_WRITE === '1'
      ? it
      : it.skip;

  writeIt(
    'reads a real uploaded photo from R2 and describes it, then removes it',
    async () => {
      loadEnv({ path: `${process.cwd()}/.env` });
      const config = new ConfigService(process.env);
      const bucket = config.getOrThrow<string>('R2_BUCKET_NAME');
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${config.getOrThrow<string>('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
          secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
        },
        forcePathStyle: true,
      });
      const userId = 'live-check-user';
      const key = `chat-images/${userId}/${randomUUID()}.jpeg`;
      const bytes = readFileSync(process.env.CHAT_IMAGE_LIVE_FILE as string);
      const appConfig = { get: () => undefined };

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: 'image/jpeg',
        }),
      );
      try {
        const useCase = new DescribeChatImagesUseCase(
          new R2ChatImageStorageService(config),
          new GroqVisionAdapter(config),
          appConfig as never,
          new RefuseRagInputUseCase(appConfig as never),
        );
        const [context] = await useCase.execute({
          userId,
          images: [{ fileKey: key, mimeType: 'image/jpeg' }],
        });
        console.log(`[live r2 photo] ${JSON.stringify(context)}`);
        expect(
          `${context.description} ${context.ocrText ?? ''} ${context.objects.join(' ')}`,
        ).toMatch(/bike|bicycle|cycl/i);
      } finally {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }
      await expect(
        s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
      ).rejects.toMatchObject({
        name: expect.stringMatching(/NotFound|NoSuchKey/),
      });
    },
  );
});
