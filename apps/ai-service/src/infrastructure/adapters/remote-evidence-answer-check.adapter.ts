import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IEvidenceAnswerCheck } from '@ai/domain/interfaces/evidence-answer-check.interface';
import { CloudflareStructuredLlmAdapter } from '@ai/infrastructure/adapters/cloudflare-structured-llm.adapter';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

// Measured offline 2026-11-27 (167 questions): with the closest excerpt between 0.55 and 0.65, 27 of 27 questions
// about topics the video does not cover were judged NOT_ANSWERED; of the 3 covered questions there, the one whose
// excerpt states the answer (a Korean question at 0.566) was judged ANSWERED and the two whose excerpts do not were
// NOT_ANSWERED. 0.60 keeps the band to where that was measured (15 uncovered, 2 covered).
const DEFAULT_RESCUE_MAX_DISTANCE = 0.6;
const TIMEOUT_MS = 10_000;
const MAX_EXCERPTS = 6;
const EXCERPT_CHARS = 400;
const PROMPT =
  'You check whether excerpts of a video transcript answer a question about that video. Answer ANSWERED when the excerpts state the information the question asks for (possibly in other words or another language, or with transcription errors). Answer NOT_ANSWERED when they do not contain it, even if they discuss a related topic.';

@Injectable()
export class RemoteEvidenceAnswerCheckAdapter implements IEvidenceAnswerCheck {
  private readonly logger = new Logger(RemoteEvidenceAnswerCheckAdapter.name);

  constructor(
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
    @Optional()
    private readonly model?: CloudflareStructuredLlmAdapter,
  ) {}

  /**
   * On while the remote model is enabled (AI_CLOUDFLARE_LLM_ENABLED=true); AI_EVIDENCE_ANSWER_CHECK=false turns it
   * off and AI_EVIDENCE_RESCUE_MAX_DISTANCE moves the band's upper end.
   */
  rescueMaxDistance(): number | undefined {
    if (
      !this.model ||
      this.config
        .get<string>('AI_CLOUDFLARE_LLM_ENABLED')
        ?.trim()
        .toLowerCase() !== 'true' ||
      this.config.get<string>('AI_EVIDENCE_ANSWER_CHECK') === 'false'
    ) {
      return undefined;
    }
    const value = Number(
      this.config.get<string>('AI_EVIDENCE_RESCUE_MAX_DISTANCE') ??
        DEFAULT_RESCUE_MAX_DISTANCE,
    );
    return Number.isFinite(value) && value > 0 && value <= 2
      ? value
      : DEFAULT_RESCUE_MAX_DISTANCE;
  }

  async answersQuestion(
    question: string,
    excerpts: string[],
  ): Promise<boolean | undefined> {
    const texts = excerpts
      .map((text) => text.trim())
      .filter(Boolean)
      .slice(0, MAX_EXCERPTS);
    if (!this.model || texts.length === 0) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.model.generateObject<{ verdict?: string }>({
          systemPrompt: PROMPT,
          userPrompt: `Question: ${question}\n\nVideo excerpts:\n${texts
            .map(
              (text, index) => `[${index + 1}] ${text.slice(0, EXCERPT_CHARS)}`,
            )
            .join('\n')}`,
          jsonSchema: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['ANSWERED', 'NOT_ANSWERED'] },
            },
            required: ['verdict'],
            additionalProperties: false,
          },
          temperature: 0,
          maxTokens: 20,
          modelRole: 'EVIDENCE_ANSWER_CHECK',
          schemaVersion: 'evidence_answer_check_v1',
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS);
        }),
      ]);
      const verdict = result?.verdict?.toUpperCase();
      this.logger.debug(`[EvidenceAnswerCheck] ${verdict ?? 'none'}`);
      if (verdict === 'ANSWERED') return true;
      if (verdict === 'NOT_ANSWERED') return false;
      return undefined;
    } catch (error: unknown) {
      this.logger.warn(
        `Evidence answer check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
