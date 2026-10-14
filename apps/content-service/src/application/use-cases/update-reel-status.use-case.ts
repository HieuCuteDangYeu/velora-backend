import { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  IContentRepository,
  ReelProcessingMediaMetadata,
} from '../../domain/interfaces/content.repository.interface';

@Injectable()
export class UpdateReelStatusUseCase {
  private readonly logger = new Logger(UpdateReelStatusUseCase.name);

  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
  ) {}

  async execute(
    reelId: string,
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED',
    transcript?: string,
    transcriptVtt?: string,
    transcriptSegments?: TranscriptSegment[],
    thumbnailKey?: string,
    processingStage?: string,
    processingMessage?: string,
    processingProgress?: number,
    title?: string,
    description?: string,
    tags?: string[],
    expectedProcessingAttemptId?: string,
    processingErrorCode?: string,
    processingErrorDetail?: string,
    mediaMetadata?: ReelProcessingMediaMetadata,
    sourceMode?: 'SOURCE_VIDEO' | 'EXISTING_HLS',
  ) {
    let sanitizedTranscript = transcript;
    let sanitizedTranscriptVtt = transcriptVtt?.trim() || undefined;
    let sanitizedTranscriptSegments =
      this.normalizeTranscriptSegments(transcriptSegments);
    const sanitizedTitle = this.normalizeOptionalText(title, 80);
    const sanitizedDescription = this.normalizeOptionalText(description, 500);
    const sanitizedTags = this.normalizeTags(tags);
    let nextStage = processingStage;
    let nextMessage = processingMessage;
    let nextProgress = this.normalizeProgress(processingProgress);

    if (status === 'COMPLETED') {
      if (!transcript || transcript.trim() === '') {
        sanitizedTranscript = undefined;
        sanitizedTranscriptVtt = undefined;
        sanitizedTranscriptSegments = undefined;

        this.logger.warn(
          `Reel ${reelId}: completing without transcript because transcript is missing or empty`,
        );
      } else {
        const quality = this.validateTranscriptQuality(transcript);

        if (!quality.valid) {
          sanitizedTranscript = undefined;
          sanitizedTranscriptVtt = undefined;
          sanitizedTranscriptSegments = undefined;

          this.logger.warn(
            `Reel ${reelId}: completing without transcript because transcript quality check failed: "${quality.reason}"`,
          );
        }
      }

      nextStage ??= 'READY';
      nextMessage ??= 'Video is ready to watch';
      nextProgress ??= 100;
    }

    if (status === 'PENDING') {
      nextStage ??= 'QUEUED';
      nextMessage ??= 'Queued for processing';
      nextProgress ??= 0;
    }

    if (status === 'PROCESSING') {
      nextStage ??= 'PROCESSING';
      nextMessage ??= 'Video is being processed';
      nextProgress ??= 10;
    }

    if (status === 'FAILED') {
      nextStage ??= 'FAILED';
      nextMessage ??= 'Video processing failed';
    }

    return await this.contentRepository.updateReelStatus(
      reelId,
      status,
      sanitizedTranscript,
      sanitizedTranscriptVtt,
      sanitizedTranscriptSegments,
      thumbnailKey,
      nextStage,
      nextMessage,
      nextProgress,
      sanitizedTitle,
      sanitizedDescription,
      sanitizedTags,
      expectedProcessingAttemptId,
      processingErrorCode,
      processingErrorDetail,
      mediaMetadata,
      sourceMode,
    );
  }

  private normalizeProgress(progress?: number): number | undefined {
    if (progress === undefined || !Number.isFinite(progress)) {
      return undefined;
    }

    return Math.min(100, Math.max(0, Math.round(progress)));
  }

  private validateTranscriptQuality(transcript: string): {
    valid: boolean;
    reason?: string;
  } {
    const MIN_LENGTH = 10;
    const trimmed = transcript.trim();

    if (trimmed.length < MIN_LENGTH) {
      return { valid: false, reason: `too short (${trimmed.length} chars)` };
    }

    const placeholderPatterns = [
      /^\[.+\]$/,
      /^(music|sound|noise)+$/i,
      /^(speaking|language|foreign)/i,
      /^(uh+|um+|ah+|er+)+$/i,
    ];

    for (const pattern of placeholderPatterns) {
      if (pattern.test(trimmed)) {
        return {
          valid: false,
          reason: `matches placeholder pattern: "${trimmed}"`,
        };
      }
    }

    const actualWords = trimmed.split(/\s+/).filter((w) => w.length > 1).length;

    if (actualWords < 3) {
      return {
        valid: false,
        reason: `not enough actual words (${actualWords})`,
      };
    }

    return { valid: true };
  }

  private normalizeTranscriptSegments(
    segments?: TranscriptSegment[],
  ): TranscriptSegment[] | undefined {
    if (!Array.isArray(segments)) {
      return undefined;
    }

    return segments
      .map((segment) => ({
        text: typeof segment.text === 'string' ? segment.text.trim() : '',
        start: this.normalizeTimestamp(segment.start),
        end: this.normalizeTimestamp(segment.end),
      }))
      .filter(
        (segment) =>
          segment.text.length > 0 &&
          segment.start !== undefined &&
          segment.end !== undefined &&
          segment.end >= segment.start,
      ) as TranscriptSegment[];
  }

  private normalizeTimestamp(value?: number): number | undefined {
    if (value === undefined || !Number.isFinite(value)) {
      return undefined;
    }

    return Math.max(0, Number(value.toFixed(3)));
  }

  private normalizeOptionalText(
    value: string | undefined,
    maxLength: number,
  ): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return undefined;
    }

    return trimmed.slice(0, maxLength);
  }

  private normalizeTags(tags?: string[]): string[] | undefined {
    if (!Array.isArray(tags)) {
      return undefined;
    }

    return tags
      .map((tag) => tag.trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean)
      .slice(0, 8);
  }
}
