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
 * about one chat turn in three. Every dataset prompt must produce an answer without claims.
 * Scope is strict (AI_SCOPE_MODE defaults to enforce): the router normally turns an unrelated
 * message away before this step, so this is the second line of defence for one that slips through.
 *  - in-scope chat (greeting, thanks, capability, smalltalk) is answered;
 *  - this step only trims leaks: gemma4:e2b ignores a scope instruction in about two thirds of the
 *    unrelated prompts that reach it (38 of 48, then 31 of 48 with the exact-reply wording), so the
 *    router is the real gate. The leak rate is reported and capped at DRAFT_MAX_OFF_TOPIC_ANSWERED;
 *  - none may be refused as "lack of evidence", and the prompts the assistant cannot know
 *    (an unseen video, private or live data) must still be declined, never invented.
 */
const IN_SCOPE_CATEGORIES = new Set([
  'greeting',
  'thanks',
  'capability',
  'smalltalk',
]);
const maxAnsweredOffTopic = Number(
  process.env.DRAFT_MAX_OFF_TOPIC_ANSWERED ?? 0.8,
);
const REDIRECTS_TO_VELORA = /\b(Velora|Reels?|videos?)\b/i;
const localIt = process.env.OLLAMA_LOCAL_INTEGRATION === '1' ? it : it.skip;
const model = process.env.OLLAMA_LOCAL_MODEL || 'gemma4:e2b-it-qat';

// "I do not have (enough) evidence/information/context ..." style refusals.
const EVIDENCE_REFUSAL =
  /(do not|don't|doesn't|cannot|can't|couldn't) (have|find|answer|verify|access)[^.]{0,40}(evidence|context|information|enough)|no evidence|not enough (evidence|context|information)/i;
const DECLINES =
  /(cannot|can't|do not have|don't have|unable|no access|not able)/i;

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
      const rows = readFileSync(
        join(process.cwd(), 'eval/rag/datasets/rag-chat-answers-v1.jsonl'),
        'utf8',
      )
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              id: string;
              prompt: string;
              category: string;
              expect: 'answer' | 'decline';
            },
        );
      expect(rows.length).toBeGreaterThanOrEqual(50);

      const useCase = new GenerateDraftAnswerUseCase(
        new OllamaStructuredLlmAdapter(new OllamaTextClient(config), config),
        new ChatPromptBuilderAdapter(),
        appConfig,
      );

      const failures: string[] = [];
      const refusedForEvidence: string[] = [];
      const notDeclined: string[] = [];
      const answeredOffTopic: string[] = [];
      let offTopic = 0;
      for (const { id, prompt, category, expect: expected } of rows) {
        const isOffTopic =
          expected === 'answer' && !IN_SCOPE_CATEGORIES.has(category);
        if (isOffTopic) offTopic += 1;
        try {
          const draft = await useCase.execute(chatState(prompt));
          if (!draft.answer.trim()) failures.push(`${id}: empty answer`);
          if (draft.claims.length > 0)
            failures.push(`${id}: unexpected claims`);
          if (isOffTopic && EVIDENCE_REFUSAL.test(draft.answer)) {
            refusedForEvidence.push(`${id}: ${draft.answer.slice(0, 80)}`);
          }
          if (isOffTopic && !REDIRECTS_TO_VELORA.test(draft.answer)) {
            answeredOffTopic.push(`${id}: ${draft.answer.slice(0, 80)}`);
          }
          // Live data (weather, prices) is now off-topic, so the Velora redirect counts as a decline.
          if (
            expected === 'decline' &&
            !DECLINES.test(draft.answer) &&
            !REDIRECTS_TO_VELORA.test(draft.answer)
          ) {
            notDeclined.push(`${id}: ${draft.answer.slice(0, 80)}`);
          }
        } catch (error: unknown) {
          failures.push(
            `${id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      expect(offTopic).toBeGreaterThanOrEqual(40);
      console.log(
        JSON.stringify({ offTopic, answeredOffTopic: answeredOffTopic.length }),
      );
      console.log(answeredOffTopic.join('\n'));
      expect(failures).toEqual([]);
      // Never invent an answer to something the assistant cannot know.
      expect(notDeclined).toEqual([]);
      expect(refusedForEvidence).toEqual([]);
      expect(answeredOffTopic.length).toBeLessThanOrEqual(
        Math.floor(offTopic * maxAnsweredOffTopic),
      );
    },
  );
});
