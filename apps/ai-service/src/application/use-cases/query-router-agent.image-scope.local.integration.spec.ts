import { LangGraphRagChatWorkflowAdapter } from '@ai/infrastructure/adapters/langgraph-rag-chat-workflow.adapter';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { withRagImageHint } from '@ai/domain/services/rag-image-context';
import { OllamaStructuredLlmAdapter } from '@ai/infrastructure/adapters/ollama-structured-llm.adapter';
import { OllamaTextClient } from '@ai/infrastructure/adapters/ollama-text.client';
import { DEFAULT_IMAGE_ONLY_QUESTION } from '@common/ai/chat-image';
import { ConfigService } from '@nestjs/config';
import { QueryRouterAgentUseCase } from './query-router-agent.use-case';

/**
 * Opt-in: runs the real router on the real local model against photo turns, where the
 * message carries the "[Attached image shows: ...]" note. Velora-related photo requests
 * (finding reels like the photo) must stay in scope; questions about the photo itself
 * (identify it, fix it, solve it, translate it) must be turned away.
 *
 *   OLLAMA_LOCAL_INTEGRATION=1 [OLLAMA_LOCAL_MODEL=gemma4:e2b-it-qat] \
 *     npx jest query-router-agent.image-scope.local.integration
 */
const localIt = process.env.OLLAMA_LOCAL_INTEGRATION === '1' ? it : it.skip;
const model = process.env.OLLAMA_LOCAL_MODEL || 'gemma4:e2b-it-qat';

const config = new ConfigService({
  OLLAMA_TEXT_BASE_URL:
    process.env.OLLAMA_TEXT_BASE_URL || 'http://127.0.0.1:11434',
  OLLAMA_STRUCTURED_TIMEOUT_MS: '120000',
  AI_ROUTER_MODEL: model,
});
const appConfig = {
  get: () => undefined,
  model: () => model,
  timeoutMs: () => 120_000,
  maxCompletionTokens: () => 512,
  boolean: (_key: string, fallback: boolean) => fallback,
  number: (_key: string, fallback: number) => fallback,
} as never;

const photo = (description: string, objects: string[], ocrText?: string) => [
  { description, objects, ...(ocrText ? { ocrText } : {}) },
];

const IN_SCOPE: Array<[string, string, ReturnType<typeof photo>]> = [
  [
    'vi find',
    'tìm reel giống ảnh này',
    photo('A red bicycle leaning on a wall', ['bicycle', 'wall']),
  ],
  [
    'en find',
    'find reels like this',
    photo('A busy city street at night with neon signs', ['street', 'neon']),
  ],
  [
    'vi dish',
    'Velora có video nào về món này không?',
    photo('A bowl of noodle soup with herbs', ['bowl', 'noodles']),
  ],
  [
    'default question',
    DEFAULT_IMAGE_ONLY_QUESTION,
    photo('A sunset over a beach', ['sun', 'sea']),
  ],
  [
    'en similar',
    'Suggest similar videos',
    photo('A person playing an acoustic guitar', ['guitar']),
  ],
  [
    'en place',
    'Is there a reel showing this place?',
    photo('A stone bridge over a river in a old town', ['bridge', 'river']),
  ],
  [
    'vi topic',
    'gợi ý reel cùng chủ đề với ảnh này',
    photo('Dogs running in a park', ['dog', 'park']),
  ],
  [
    'en creators',
    'show me reels from creators who post things like this',
    photo('A close-up of latte art in a ceramic cup', ['coffee', 'cup']),
  ],
  [
    'en topic',
    'what reels are about this?',
    photo('A skateboarder jumping over stairs', ['skateboard', 'stairs']),
  ],
  [
    'vi scene',
    'xem có reel nào quay cảnh này không',
    photo('A mountain lake at sunrise with mist', ['mountain', 'lake']),
  ],
  [
    'en recommend',
    'recommend videos similar to this photo',
    photo('A chef plating a dessert in a kitchen', ['chef', 'dessert']),
  ],
  [
    'vi food',
    'tìm video có món ăn giống trong hình',
    photo('A plate of grilled fish with vegetables', ['fish', 'plate']),
  ],
];

const OFF_TOPIC: Array<[string, string, ReturnType<typeof photo>]> = [
  ['vi identify', 'đây là con gì?', photo('A cat on a sofa', ['cat', 'sofa'])],
  [
    'en plant care',
    'What is this plant and how do I care for it?',
    photo('A green houseplant in a pot', ['plant', 'pot']),
  ],
  [
    'en math',
    'Solve this equation',
    photo(
      'A whiteboard with a handwritten equation',
      ['whiteboard'],
      '2x+3=11',
    ),
  ],
  [
    'en translate',
    'Translate the text in this photo to English',
    photo('A street sign with Vietnamese text', ['sign'], 'Cấm đỗ xe'),
  ],
  [
    'en repair',
    'How do I fix this leaking pipe?',
    photo('A leaking pipe under a sink', ['pipe', 'sink']),
  ],
  [
    'en person',
    'Who is the person in this photo?',
    photo('A portrait of a smiling man', ['man']),
  ],
  [
    'en health',
    'Is this mole dangerous?',
    photo('A close-up of skin with a dark spot', ['skin']),
  ],
  [
    'en calories',
    'How many calories are in this meal?',
    photo('A plate of pasta with tomato sauce', ['pasta', 'plate']),
  ],
  [
    'en breed',
    'What breed is this dog?',
    photo('A brown dog sitting on grass', ['dog', 'grass']),
  ],
  [
    'en caption',
    'Write a caption for this photo for my Instagram',
    photo('Friends laughing at a beach party', ['people', 'beach']),
  ],
  [
    'vi read text',
    'đọc giúp mình chữ trong ảnh',
    photo(
      'A printed letter on a desk',
      ['letter', 'desk'],
      'Dear Sir or Madam',
    ),
  ],
  [
    'en code',
    "What's wrong with my code?",
    photo(
      'A screenshot of source code with an error',
      ['screen'],
      'TypeError: x is undefined',
    ),
  ],
  [
    'en medicine',
    'Which medicine is this and what is the dose?',
    photo('A white pill bottle with a label', ['bottle']),
  ],
];

describe('router scope policy for photo turns (opt-in, real model)', () => {
  jest.setTimeout(30 * 60_000);

  localIt('keeps Velora photo requests and turns the rest away', async () => {
    const router = new QueryRouterAgentUseCase(
      new OllamaStructuredLlmAdapter(new OllamaTextClient(config), config),
      appConfig,
    );
    const routeOf = async (
      caption: string,
      images: ReturnType<typeof photo>,
    ) => {
      try {
        return await router.execute({
          message: withRagImageHint(caption, images),
          recentHistory: '',
          hasSharedReelContext: false,
          sharedReelCount: 0,
          referentContext: {
            conversationHasSharedReelContext: false,
            accessibleSharedReelCount: 0,
            recentShareEvent: false,
            recentEventTypes: [],
          },
        });
      } catch {
        return null;
      }
    };

    const wrong: string[] = [];
    let falseRefusals = 0;
    let caught = 0;
    const queries: string[] = [];
    for (const [label, caption, images] of IN_SCOPE) {
      const decision = await routeOf(caption, images);
      const action = decision?.recommendationAction;
      queries.push(
        `${label}: ${decision?.intent} ${action?.type} "${action?.query ?? ''}"`,
      );
      if (decision?.intent === 'OFF_TOPIC') {
        falseRefusals += 1;
        wrong.push(`REFUSED ${label}: ${caption}`);
      }
    }
    for (const [label, caption, images] of OFF_TOPIC) {
      const decision = await routeOf(caption, images);
      if (decision?.intent === 'OFF_TOPIC') caught += 1;
      else wrong.push(`MISSED ${label} -> ${decision?.intent}: ${caption}`);
    }

    console.log(
      `[photo scope] model=${model} falseRefusals=${falseRefusals}/${IN_SCOPE.length} caught=${caught}/${OFF_TOPIC.length}\n${wrong.join('\n')}\n${queries.join('\n')}`,
    );
    expect(falseRefusals).toBeLessThanOrEqual(1);
    expect(caught).toBeGreaterThanOrEqual(Math.ceil(OFF_TOPIC.length * 0.85));
  });

  localIt(
    'ends every Velora photo request as a reel search through the graph router node',
    async () => {
      const router = new QueryRouterAgentUseCase(
        new OllamaStructuredLlmAdapter(new OllamaTextClient(config), config),
        appConfig,
      );
      const workflow = new LangGraphRagChatWorkflowAdapter(
        router,
        ...(Array(12).fill(undefined) as [
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never,
        ]),
        { get: jest.fn() } as never,
        undefined as never,
      ) as unknown as {
        createQueryRouterNode: (
          timings: Record<string, number>,
        ) => (
          state: RagChatWorkflowState,
        ) => Promise<Partial<RagChatWorkflowState>>;
      };
      const node = workflow.createQueryRouterNode({});

      const notSearches: string[] = [];
      for (const [label, caption, images] of IN_SCOPE) {
        const { route } = await node({
          userId: 'u',
          conversationId: 'c',
          userMessage: caption,
          images,
        } as RagChatWorkflowState);
        const finalType = route?.recommendationAction.type;
        console.log(`[photo graph] ${label}: ${route?.intent} ${finalType}`);
        if (route?.intent !== 'OFF_TOPIC' && finalType !== 'RECOMMEND_REELS') {
          notSearches.push(`${label}: ${route?.intent} ${finalType}`);
        }
      }
      expect(notSearches).toEqual([]);
    },
  );
});
