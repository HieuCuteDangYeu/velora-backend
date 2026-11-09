import { ChatPromptBuilderAdapter } from '@ai/infrastructure/adapters/chat-prompt-builder.adapter';
import { OllamaStructuredLlmAdapter } from '@ai/infrastructure/adapters/ollama-structured-llm.adapter';
import { OllamaTextClient } from '@ai/infrastructure/adapters/ollama-text.client';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GenerateDraftAnswerUseCase } from './generate-draft-answer.use-case';

/**
 * Opt-in: runs the real draft step against the real local model, because the failure this
 * guards against (a small model writing placeholder evidence IDs such as "N/A" for a chat
 * turn that has no evidence) cannot be reproduced with a stub.
 *
 *   OLLAMA_LOCAL_INTEGRATION=1 [OLLAMA_LOCAL_MODEL=gemma4:e2b-it-qat] \
 *     npx jest generate-draft-answer.chat.local.integration
 *
 * Production answers with the smallest Gemma (e2b), which is where this used to fail
 * about one chat turn in three. Every dataset prompt must produce an answer.
 */
const localIt = process.env.OLLAMA_LOCAL_INTEGRATION === '1' ? it : it.skip;
const model = process.env.OLLAMA_LOCAL_MODEL || 'gemma4:e2b-it-qat';

const config = new ConfigService({
  OLLAMA_TEXT_BASE_URL:
    process.env.OLLAMA_TEXT_BASE_URL || 'http://127.0.0.1:11434',
  OLLAMA_STRUCTURED_TIMEOUT_MS: '120000',
  AI_ANSWER_MODEL: model,
});
const appConfig = {
  get: () => undefined,
  model: () => model,
  timeoutMs: () => 120_000,
  maxCompletionTokens: () => 1_536,
  boolean: (_key: string, fallback: boolean) => fallback,
  number: (_key: string, fallback: number) => fallback,
} as never;

const chatState = (userMessage: string) =>
  ({
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessage,
    accessibleReelIds: [],
    rerankedChunks: [],
    retrievedChunks: [],
    memorySelection: {},
    answerDiagnostics: [],
    citations: [],
    nextDraftSource: 'INITIAL',
    route: {
      intent: 'NORMAL_CHAT',
      referenceTarget: 'NONE',
      needsRetrieval: false,
      needsUserMemory: false,
      needsConversationSummary: false,
      needsVerification: false,
      reelQuestionType: 'NONE',
      requiredEvidence: ['NONE'],
      transcriptRequestKind: 'NONE',
      recommendationAction: { type: 'NONE', reason: '' },
      reason: 'chat',
    },
  }) as unknown as RagChatWorkflowState;

describe('chat answers from the real local model (opt-in)', () => {
  jest.setTimeout(30 * 60_000);

  localIt(
    'answers every chat prompt without a claim-contract failure',
    async () => {
      const prompts = readFileSync(
        join(process.cwd(), 'eval/rag/datasets/rag-chat-answers-v1.jsonl'),
        'utf8',
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string; prompt: string });
      expect(prompts.length).toBeGreaterThanOrEqual(20);

      const useCase = new GenerateDraftAnswerUseCase(
        new OllamaStructuredLlmAdapter(new OllamaTextClient(config), config),
        new ChatPromptBuilderAdapter(),
        appConfig,
      );

      const failures: string[] = [];
      for (const { id, prompt } of prompts) {
        try {
          const draft = await useCase.execute(chatState(prompt));
          if (!draft.answer.trim()) failures.push(`${id}: empty answer`);
          if (draft.claims.length > 0)
            failures.push(`${id}: unexpected claims`);
        } catch (error: unknown) {
          failures.push(
            `${id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
  );
});
