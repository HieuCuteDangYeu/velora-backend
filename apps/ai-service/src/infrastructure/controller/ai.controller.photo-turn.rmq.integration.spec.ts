import { DescribeChatImagesUseCase } from '@ai/application/use-cases/describe-chat-images.use-case';
import { RefuseRagInputUseCase } from '@ai/application/use-cases/refuse-rag-input.use-case';
import { StreamChatUseCase } from '@ai/application/use-cases/stream-chat.use-case';
import { GroqVisionAdapter } from '@ai/infrastructure/adapters/groq-vision.adapter';
import { R2ChatImageStorageService } from '@ai/infrastructure/services/r2-chat-image-storage.service';
import { DEFAULT_IMAGE_ONLY_QUESTION } from '@common/ai/chat-image';
import type { AskQuestionPayload } from '@common/ai/dtos/ask-question.dto';
import type { INestApplication } from '@nestjs/common';
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientProxyFactory,
  type ClientProxy,
  MessagePattern,
  Payload,
  Transport,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AiServiceAdapter } from '../../../../conversation-service/src/infrastructure/adapters/ai-service.adapter';
import { AiController } from './ai.controller';

/**
 * Opt-in: sends the real conversation-service AiServiceAdapter call over a real RabbitMQ queue to
 * the real ai-service handler, stream-chat use case and photo reader. The photo bytes come from a
 * synthetic picture, the vision call is real (Groq), and the missing-object case reads real R2
 * (read-only, a key that does not exist). Only the RAG workflow itself is faked, to capture what
 * it receives.
 *
 *   RMQ_PHOTO_E2E=1 RABBITMQ_TEST_URL=amqp://127.0.0.1:56720 AI_VISION_PROVIDER=groq \
 *     CHAT_IMAGE_LIVE_FILE=/path/to/picture.jpg npx jest ai.controller.photo-turn.rmq
 */
const e2eIt = process.env.RMQ_PHOTO_E2E === '1' ? it : it.skip;
const USER = 'live-check-user';

@Controller()
class StreamQuestionTransport {
  constructor(private readonly controller: AiController) {}

  @MessagePattern('ai.stream_question')
  handle(@Payload() data: AskQuestionPayload) {
    return this.controller.handleStreamQuestion(data);
  }
}

describe('photo turn over RabbitMQ (opt-in)', () => {
  jest.setTimeout(180_000);
  let app: INestApplication;
  let adapter: AiServiceAdapter;
  let client: ClientProxy;
  const workflow = {
    execute: jest.fn().mockResolvedValue({ answer: 'ok', citations: [] }),
  };

  beforeAll(async () => {
    if (process.env.RMQ_PHOTO_E2E !== '1') return;
    loadEnv({ path: `${process.cwd()}/.env` });
    const config = new ConfigService(process.env);
    const bytes = readFileSync(process.env.CHAT_IMAGE_LIVE_FILE as string);
    const r2 = new R2ChatImageStorageService(config);
    // A found photo is the synthetic picture; any other own key goes to real R2.
    const storage = {
      downloadImage: (key: string, maxBytes: number) =>
        key.includes('/found-')
          ? Promise.resolve(bytes)
          : r2.downloadImage(key, maxBytes),
    };
    const appConfig = { get: () => undefined };
    const refuse = new RefuseRagInputUseCase(appConfig as never);
    const streamChat = new StreamChatUseCase(
      workflow,
      { run: <T>(task: () => Promise<T>) => task() },
      refuse,
      new DescribeChatImagesUseCase(
        storage,
        new GroqVisionAdapter(config),
        appConfig as never,
        refuse,
      ),
    );
    const controller = new AiController(
      ...(Array(6).fill(undefined) as [
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
      streamChat,
      ...(Array(5).fill(undefined) as [never, never, never, never, never]),
    );
    const url = process.env.RABBITMQ_TEST_URL as string;
    const queue = `ai_queue_photo_e2e_${randomUUID()}`;
    const options = { urls: [url], queue, queueOptions: { durable: false } };

    const moduleRef = await Test.createTestingModule({
      controllers: [StreamQuestionTransport],
      providers: [{ provide: AiController, useValue: controller }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.connectMicroservice({ transport: Transport.RMQ, options });
    await app.startAllMicroservices();
    await app.init();
    client = ClientProxyFactory.create({ transport: Transport.RMQ, options });
    adapter = new AiServiceAdapter(client);
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  beforeEach(() => workflow.execute.mockClear());

  e2eIt(
    'delivers the caption and a described photo to the workflow',
    async () => {
      const result = await adapter.askQuestionStream({
        message: 'find reels like this',
        userId: USER,
        conversationId: 'conversation-1',
        images: [
          {
            fileKey: `chat-images/${USER}/found-${randomUUID()}.jpeg`,
            mimeType: 'image/jpeg',
          },
        ],
      });

      expect(result.error).toBeUndefined();
      expect(result.answer).toBe('ok');
      const received = workflow.execute.mock.calls[0][0] as {
        message: string;
        images: Array<{ description: string; ocrText?: string }>;
      };
      expect(received.message).toBe('find reels like this');
      expect(
        `${received.images[0].description} ${received.images[0].ocrText ?? ''}`,
      ).toMatch(/bike|bicycle/i);
    },
  );

  e2eIt(
    'asks the Velora-scoped default question for a bare photo',
    async () => {
      await adapter.askQuestionStream({
        message: '',
        userId: USER,
        conversationId: 'conversation-1',
        images: [
          {
            fileKey: `chat-images/${USER}/found-${randomUUID()}.jpeg`,
            mimeType: 'image/jpeg',
          },
        ],
      });

      expect(workflow.execute.mock.calls[0][0]).toMatchObject({
        message: DEFAULT_IMAGE_ONLY_QUESTION,
      });
    },
  );

  e2eIt(
    "returns IMAGE_UNREADABLE for another user's key without running the workflow",
    async () => {
      const result = await adapter.askQuestionStream({
        message: 'what is this',
        userId: USER,
        conversationId: 'conversation-1',
        images: [
          {
            fileKey: 'chat-images/someone-else/abc.jpeg',
            mimeType: 'image/jpeg',
          },
        ],
      });

      expect(result.answer).toBeNull();
      expect(result.error?.code).toBe('IMAGE_UNREADABLE');
      expect(workflow.execute).not.toHaveBeenCalled();
    },
  );

  e2eIt(
    'returns IMAGE_UNREADABLE for an own key that is missing from real R2',
    async () => {
      const result = await adapter.askQuestionStream({
        message: 'what is this',
        userId: USER,
        conversationId: 'conversation-1',
        images: [
          {
            fileKey: `chat-images/${USER}/${randomUUID()}.jpeg`,
            mimeType: 'image/jpeg',
          },
        ],
      });

      expect(result.error?.code).toBe('IMAGE_UNREADABLE');
      expect(workflow.execute).not.toHaveBeenCalled();
    },
  );
});
