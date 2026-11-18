import { ChatBusyError } from '@ai/domain/errors/chat-busy.error';
import { ChatImageUnreadableError } from '@ai/domain/errors/chat-image-unreadable.error';
import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IChatImageStorageService } from '@ai/domain/interfaces/chat-image-storage.service.interface';
import type { IVisionService } from '@ai/domain/interfaces/vision.service.interface';
import type { RagImageContext } from '@ai/domain/services/rag-image-context';
import type { VisualFrameAnalysis } from '@common/ai/interfaces/visual-analysis.interface';
import {
  isChatImageKeyOwnedBy,
  MAX_CHAT_IMAGES_PER_AI_TURN,
} from '@common/ai/chat-image';
import type { AskQuestionImage } from '@common/ai/dtos/ask-question.dto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RefuseRagInputUseCase } from './refuse-rag-input.use-case';

const QUOTA_ERROR =
  /\b429\b|daily free allocation|rate[- ]?limit|quota|too many requests|key pool|no capacity/i;
const BUSY_RETRY_AFTER_SECONDS = 60;
const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_OCR_CHARS = 600;
const MAX_OBJECTS = 12;

/**
 * Turns the photos on a chat turn into text the RAG pipeline can use. The bytes are read
 * from storage by key, never from a URL the client supplied, and only for keys the
 * requester's own upload produced.
 */
@Injectable()
export class DescribeChatImagesUseCase {
  private readonly logger = new Logger(DescribeChatImagesUseCase.name);

  constructor(
    @Inject('IChatImageStorageService')
    private readonly storage: IChatImageStorageService,
    @Inject('IVisionService')
    private readonly vision: IVisionService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
    private readonly refuseRagInput: RefuseRagInputUseCase,
  ) {}

  async execute(input: {
    userId: string;
    images: readonly AskQuestionImage[];
  }): Promise<RagImageContext[]> {
    if (input.images.length > MAX_CHAT_IMAGES_PER_AI_TURN) {
      throw new ChatImageUnreadableError('TOO_LARGE');
    }

    // Checked for every image before any download, so one bad key costs nothing.
    for (const image of input.images) {
      if (!isChatImageKeyOwnedBy(input.userId, image.fileKey)) {
        throw new ChatImageUnreadableError('NOT_OWNED');
      }
    }

    const maxBytes = this.maxImageBytes();
    const contexts: RagImageContext[] = [];
    // One at a time: the vision keys are free-tier and shared with reel indexing.
    for (const image of input.images) {
      const bytes = await this.storage.downloadImage(image.fileKey, maxBytes);
      contexts.push(await this.describe(bytes, image));
    }
    return contexts;
  }

  private async describe(
    bytes: Buffer,
    image: AskQuestionImage,
  ): Promise<RagImageContext> {
    let analysis: VisualFrameAnalysis;
    try {
      analysis = await this.vision.analyzeImage({
        image: bytes,
        mimeType: image.mimeType,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Chat image vision failed: ${message}`);
      if (QUOTA_ERROR.test(message)) {
        throw new ChatBusyError(BUSY_RETRY_AFTER_SECONDS);
      }
      throw new ChatImageUnreadableError('VISION_FAILED');
    }

    const description = analysis.caption?.trim();
    if (!description) throw new ChatImageUnreadableError('VISION_FAILED');

    let ocrText = analysis.ocrText?.trim().slice(0, MAX_OCR_CHARS) || undefined;
    if (ocrText) {
      // Text inside a photo is attacker-controllable. The pattern check that guards typed
      // input also screens it; a hit drops the text but keeps the rest of the description.
      const refusal = this.refuseRagInput.execute({ message: ocrText });
      if (refusal.refuse) {
        this.logger.warn(
          `[Guardrail] image OCR dropped codes=${refusal.codes.join(',') || '-'}`,
        );
        ocrText = undefined;
      }
    }

    return {
      description,
      ...(ocrText ? { ocrText } : {}),
      objects: (analysis.objects ?? [])
        .map((object) => object.trim())
        .filter(Boolean)
        .slice(0, MAX_OBJECTS),
    };
  }

  private maxImageBytes(): number {
    const configured = Number(
      this.config.get<string>('AI_VISION_MAX_IMAGE_BYTES') ??
        DEFAULT_MAX_IMAGE_BYTES,
    );
    return Number.isFinite(configured) && configured > 0
      ? Math.min(20 * 1024 * 1024, Math.max(64 * 1024, Math.round(configured)))
      : DEFAULT_MAX_IMAGE_BYTES;
  }
}
