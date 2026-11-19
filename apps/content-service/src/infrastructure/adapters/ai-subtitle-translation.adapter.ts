import {
  SUBTITLE_TRANSLATION_MAX_CUES,
  type TranslateSubtitleCuesRequest,
  type TranslateSubtitleCuesResult,
} from '@common/ai/interfaces/subtitle-translation.interface';
import { isRpcError } from '@common/constants/rpc-error.types';
import type { ISubtitleTranslationService } from '@content/domain/interfaces/subtitle-translation.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom, timeout } from 'rxjs';

// One request is several batches of a small local model, so its time grows with its size.
const TRANSLATION_TIMEOUT_MS = 5 * 60 * 1000;

// The AI service refuses more than SUBTITLE_TRANSLATION_MAX_CUES lines at once, and a request that large would not
// finish inside the timeout on the local model. Longer transcripts are translated in consecutive requests of this size.
export const SUBTITLE_TRANSLATION_CHUNK_CUES = Math.min(
  100,
  SUBTITLE_TRANSLATION_MAX_CUES,
);

@Injectable()
export class AiSubtitleTranslationAdapter implements ISubtitleTranslationService {
  constructor(
    @Inject('AI_SERVICE_RMQ')
    private readonly aiClient: ClientProxy,
  ) {}

  async translate(
    request: TranslateSubtitleCuesRequest,
  ): Promise<TranslateSubtitleCuesResult> {
    if (request.cues.length <= SUBTITLE_TRANSLATION_CHUNK_CUES) {
      return this.translateChunk(request);
    }

    // Consecutive on purpose: the model is local, and a failed chunk stops the work instead of wasting the rest.
    const cues: TranslateSubtitleCuesResult['cues'] = [];
    let model = '';
    for (
      let from = 0;
      from < request.cues.length;
      from += SUBTITLE_TRANSLATION_CHUNK_CUES
    ) {
      const part = await this.translateChunk({
        ...request,
        cues: request.cues.slice(from, from + SUBTITLE_TRANSLATION_CHUNK_CUES),
      });
      cues.push(...part.cues);
      model = part.model;
    }
    return { cues, model };
  }

  private translateChunk(
    request: TranslateSubtitleCuesRequest,
  ): Promise<TranslateSubtitleCuesResult> {
    return lastValueFrom(
      this.aiClient
        .send<TranslateSubtitleCuesResult>(
          'ai.translate_subtitle_cues',
          request,
        )
        .pipe(
          timeout(TRANSLATION_TIMEOUT_MS),
          catchError((error: unknown) => {
            if (isRpcError(error)) {
              const message = Array.isArray(error.message)
                ? error.message.join(', ')
                : error.message;
              throw new Error(
                `AI service error [${error.statusCode}]: ${message}`,
              );
            }
            const message =
              error instanceof Error ? error.message : String(error);
            throw new Error(`AI service unreachable: ${message}`);
          }),
        ),
    );
  }
}
