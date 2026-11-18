import { ChatPromptBuilderAdapter } from '@ai/infrastructure/adapters/chat-prompt-builder.adapter';
import { OllamaStructuredLlmAdapter } from '@ai/infrastructure/adapters/ollama-structured-llm.adapter';
import { OllamaTextClient } from '@ai/infrastructure/adapters/ollama-text.client';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import {
  cosineSimilarity,
  rankRecalledMessages,
  selectEmbeddingCandidates,
  strongRecallMatch,
} from '@ai/domain/services/rank-recalled-messages';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GenerateDraftAnswerUseCase } from './generate-draft-answer.use-case';
import { VerifierAgentUseCase } from './verifier-agent.use-case';

/**
 * Opt-in: replays the answer step of a conversation-recall question against the real local
 * model (gemma4:e2b, the one production uses). The router is skipped: each case is already a
 * CONVERSATION_MEMORY_QUESTION with the evidence the graph would assemble (the last 12 messages,
 * the ranked older messages from cached real embeddings, no saved facts). It measures the part
 * that failed in production: does the draft say the right thing, and does the verifier accept it.
 *
 *   RECALL_LOCAL=1 RECALL_VECTORS=/path/vectors.json [RECALL_CASES=40] \
 *     npx jest recall-answers.local.integration
 *
 * Vectors come from eval/rag/conversation-recall-embed.cjs (see eval/rag/README.md). The model
 * host is shared with production: keep RECALL_CASES small and never load another model on it.
 */
const enabled =
  process.env.RECALL_LOCAL === '1' && Boolean(process.env.RECALL_VECTORS);
const localIt = enabled ? it : it.skip;
const model = process.env.OLLAMA_LOCAL_MODEL || 'gemma4:e2b-it-qat';

const config = new ConfigService({
  OLLAMA_TEXT_BASE_URL:
    process.env.OLLAMA_TEXT_BASE_URL || 'http://127.0.0.1:11434',
  OLLAMA_STRUCTURED_TIMEOUT_MS: '120000',
  AI_ANSWER_MODEL: model,
  AI_VERIFIER_MODEL: model,
});
const appConfig = {
  get: () => undefined,
  model: () => model,
  timeoutMs: () => 120_000,
  maxCompletionTokens: () => 1_536,
  boolean: (_key: string, fallback: boolean) => fallback,
  number: (_key: string, fallback: number) => fallback,
} as never;

interface Row {
  id: string;
  kind: string;
  distance: number;
  question: string;
  expect: string[];
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
}

const NEGATIVE_CLAIM =
  /(could not find|couldn't find|do not|don't|did not|didn't|not (?:see|mentioned|have)|no (?:record|information|mention))/i;

describe('recall answers from the real local model (opt-in)', () => {
  jest.setTimeout(60 * 60_000);

  localIt('drafts and verifies recall answers', async () => {
    const vectors = JSON.parse(
      readFileSync(process.env.RECALL_VECTORS!, 'utf8'),
    ) as Record<string, number[]>;
    const rows = readFileSync(
      join(process.cwd(), 'eval/rag/datasets/rag-conversation-recall-v1.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);
    // A spread across kinds, distances 14-70 and negatives; deterministic.
    const wanted = Number(process.env.RECALL_CASES ?? 40);
    const pool = rows.filter(
      (row) =>
        row.kind === 'negative' || (row.distance >= 14 && row.distance <= 70),
    );
    const stride = Math.max(1, Math.floor(pool.length / wanted));
    const sample = pool
      .filter((_, index) => index % stride === 0)
      .slice(0, wanted);

    const llm = new OllamaStructuredLlmAdapter(
      new OllamaTextClient(config),
      config,
    );
    const draftUseCase = new GenerateDraftAnswerUseCase(
      llm,
      new ChatPromptBuilderAdapter(),
      appConfig,
    );
    const verifier = new VerifierAgentUseCase(llm, appConfig);

    const stats: Record<
      string,
      {
        n: number;
        correct: number;
        verified: number;
        both: number;
        visible: number;
      }
    > = {};
    const lines: string[] = [];
    for (const row of sample) {
      const recent = row.history.slice(-12);
      const older = row.history
        .slice(0, Math.max(0, row.history.length - 12))
        .slice(-80);
      const candidates = older.slice(-60);
      const embedded = new Set(selectEmbeddingCandidates(candidates, 20));
      const semantic = candidates.map((message, index) =>
        embedded.has(index) && vectors[message.content] && vectors[row.question]
          ? cosineSimilarity(vectors[row.question], vectors[message.content])
          : undefined,
      );
      const recalled = rankRecalledMessages({
        question: row.question,
        candidates,
        semantic,
      });

      const state = {
        userId: 'user-1',
        conversationId: 'conversation-1',
        userMessage: row.question,
        accessibleReelIds: [],
        rerankedChunks: [],
        retrievedChunks: [],
        answerDiagnostics: [],
        citations: [],
        nextDraftSource: 'INITIAL',
        retryCount: 0,
        citationRetryCount: 0,
        memory: { recentMessages: recent },
        recalledMessages: recalled,
        conversationMemory: { conversationId: 'conversation-1', summary: '' },
        memorySelection: {
          includeRecentHistory: true,
          includeConversationSummary: true,
          includeUserMemory: false,
          includeRetrievedChunks: false,
          reason: 'recall',
        },
        route: {
          intent: 'CONVERSATION_MEMORY_QUESTION',
          referenceTarget: 'CONVERSATION',
          needsRetrieval: false,
          needsUserMemory: false,
          needsConversationSummary: true,
          needsVerification: true,
          reelQuestionType: 'NONE',
          requiredEvidence: ['CONVERSATION_MEMORY'],
          transcriptRequestKind: 'NONE',
          recommendationAction: { type: 'NONE', reason: '' },
          reason: 'recall',
        },
      } as unknown as RagChatWorkflowState;

      const draft = await draftUseCase.execute(state);
      const verification = await verifier.execute({
        ...state,
        answer: draft.answer,
        answerClaims: draft.claims,
        generationEvidence:
          draft.generationEvidence ?? state.generationEvidence,
        answerGenerationMode: draft.finalizationMode,
      });

      const mentions = row.expect.some((word) =>
        draft.answer.toLowerCase().includes(word.toLowerCase()),
      );
      const correct =
        row.kind === 'negative' ? NEGATIVE_CLAIM.test(draft.answer) : mentions;
      const stat = (stats[row.kind] ??= {
        n: 0,
        correct: 0,
        verified: 0,
        both: 0,
        visible: 0,
      });
      stat.n += 1;
      stat.correct += correct ? 1 : 0;
      stat.verified += verification.passed ? 1 : 0;
      stat.both += correct && verification.passed ? 1 : 0;
      // What the user sees: the verified answer, or the quote when the draft failed or was rejected.
      const quoteCandidates = [
        ...candidates,
        ...recent.filter((m) => m.role === 'user'),
      ];
      const quote = strongRecallMatch({
        question: row.question,
        candidates: quoteCandidates,
        semantic: quoteCandidates.map((m) =>
          vectors[m.content] && vectors[row.question]
            ? cosineSimilarity(vectors[row.question], vectors[m.content])
            : undefined,
        ),
      });
      const quoteRight = row.kind !== 'negative' && quote?.content === row.gold;
      const quoteWrong = quote !== undefined && !quoteRight;
      const answerFine = verification.passed && correct;
      // A rejected or wrong draft falls back to the quote; a quote that is not the fact counts as wrong.
      const visibleOk =
        answerFine ||
        (!verification.passed
          ? quoteRight || (row.kind === 'negative' && !quote)
          : false);
      stat.visible += visibleOk ? 1 : 0;
      if (!verification.passed && quoteWrong)
        lines.push(`   (wrong quote offered: ${quote?.content.slice(0, 70)})`);
      lines.push(
        `${correct ? 'ok ' : 'BAD'} ${verification.passed ? 'verified' : 'REJECTED'} | ${row.kind} d=${row.distance} recalled=${recalled.length} | ${row.question} -> ${draft.answer.replace(/\s+/g, ' ').slice(0, 110)}${verification.passed ? '' : ` | issues: ${verification.issues.join('; ').slice(0, 120)}`}`,
      );
    }

    console.log(`\n${lines.join('\n')}\n`);
    console.table(stats);
    const total = Object.values(stats).reduce((sum, s) => sum + s.n, 0);
    const good = Object.values(stats).reduce((sum, s) => sum + s.both, 0);
    const visible = Object.values(stats).reduce((sum, s) => sum + s.visible, 0);
    console.log(
      `correct and verified: ${good}/${total}; what the user sees with the quote fallback: ${visible}/${total}`,
    );
    expect(total).toBeGreaterThan(0);
  });
});
