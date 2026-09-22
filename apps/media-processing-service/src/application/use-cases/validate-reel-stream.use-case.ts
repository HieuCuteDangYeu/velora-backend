import { Inject, Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import type { IMediaStorageService } from '../../domain/interfaces/media-storage.service.interface';

export class ReelStreamValidationError extends Error {
  constructor(
    message: string,
    readonly technicalReason: string,
  ) {
    super(message);
    this.name = 'ReelStreamValidationError';
  }
}

interface PlaylistReference {
  line: string;
  key: string;
}

const SAFE_STREAM_VALIDATION_MESSAGE =
  'Streaming files could not be prepared. Please try again.';

@Injectable()
export class ValidateReelStreamUseCase {
  private readonly logger = new Logger(ValidateReelStreamUseCase.name);

  constructor(
    @Inject('IMediaStorageService')
    private readonly mediaStorageService: IMediaStorageService,
  ) {}

  async execute(data: {
    reelId: string;
    s3Prefix: string;
    thumbnailKey: string;
  }): Promise<void> {
    const s3Prefix = this.normalizePrefix(data.s3Prefix);
    const masterKey = `${s3Prefix}/master.m3u8`;

    const masterPlaylistText = await this.readRequiredPlaylist(
      data.reelId,
      masterKey,
      'master playlist is missing or unreadable',
    );

    const variantReferences = this.parseVariantPlaylistReferences(
      masterKey,
      masterPlaylistText,
    );

    if (variantReferences.length === 0) {
      throw this.validationError(
        data.reelId,
        'master playlist does not contain any variant playlists',
      );
    }

    const firstValidVariant = await this.findFirstValidVariant(
      data.reelId,
      variantReferences,
    );

    if (!firstValidVariant) {
      throw this.validationError(
        data.reelId,
        'no variant playlist contains a valid media segment',
      );
    }

    const thumbnailExists = await this.mediaStorageService.objectExists(
      data.thumbnailKey,
    );

    if (!thumbnailExists) {
      throw this.validationError(
        data.reelId,
        `thumbnail is missing: ${data.thumbnailKey}`,
      );
    }

    this.logger.log(
      `[Reel ${data.reelId}] Stream validation passed: master=${masterKey}, variant=${firstValidVariant.variantKey}, segment=${firstValidVariant.segmentKey}, thumbnail=${data.thumbnailKey}`,
    );
  }

  private async findFirstValidVariant(
    reelId: string,
    variantReferences: PlaylistReference[],
  ): Promise<{ variantKey: string; segmentKey: string } | null> {
    for (const variantReference of variantReferences) {
      const variantText = await this.readOptionalPlaylist(variantReference.key);

      if (!variantText) {
        this.logger.warn(
          `[Reel ${reelId}] Variant playlist missing or unreadable: ${variantReference.key}`,
        );
        continue;
      }

      const segmentReferences = this.parseMediaSegmentReferences(
        variantReference.key,
        variantText,
      );

      if (segmentReferences.length === 0) {
        this.logger.warn(
          `[Reel ${reelId}] Variant playlist has no media segments: ${variantReference.key}`,
        );
        continue;
      }

      const firstSegment = segmentReferences[0];

      let firstSegmentExists = false;
      if (/^https?:\/\//i.test(firstSegment.line)) {
        try {
          const res = await fetch(firstSegment.line, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
          });
          firstSegmentExists = res.ok || res.status === 206;
        } catch {
          firstSegmentExists = false;
        }
      } else {
        firstSegmentExists = await this.mediaStorageService.objectExists(
          firstSegment.key,
        );
      }

      if (!firstSegmentExists) {
        this.logger.warn(
          `[Reel ${reelId}] First media segment is missing: ${firstSegment.key}`,
        );
        continue;
      }

      return {
        variantKey: variantReference.key,
        segmentKey: firstSegment.key,
      };
    }

    return null;
  }

  private async readRequiredPlaylist(
    reelId: string,
    key: string,
    reason: string,
  ): Promise<string> {
    const text = await this.readOptionalPlaylist(key);

    if (!text) {
      throw this.validationError(reelId, `${reason}: ${key}`);
    }

    return text;
  }

  private async readOptionalPlaylist(key: string): Promise<string | null> {
    try {
      const exists = await this.mediaStorageService.objectExists(key);

      if (!exists) {
        return null;
      }

      const text = await this.mediaStorageService.getObjectText(key);
      const trimmed = text.trim();

      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private parseVariantPlaylistReferences(
    masterKey: string,
    playlistText: string,
  ): PlaylistReference[] {
    const lines = this.getMeaningfulPlaylistLines(playlistText);
    const references: PlaylistReference[] = [];

    for (const line of lines) {
      if (line.startsWith('#')) {
        continue;
      }

      if (!line.toLowerCase().includes('.m3u8')) {
        continue;
      }

      references.push({
        line,
        key: this.resolvePlaylistReference(masterKey, line),
      });
    }

    return references;
  }

  private parseMediaSegmentReferences(
    playlistKey: string,
    playlistText: string,
  ): PlaylistReference[] {
    const lines = this.getMeaningfulPlaylistLines(playlistText);
    const references: PlaylistReference[] = [];

    for (const line of lines) {
      if (line.startsWith('#')) {
        continue;
      }

      if (line.toLowerCase().includes('.m3u8')) {
        continue;
      }

      references.push({
        line,
        key: this.resolvePlaylistReference(playlistKey, line),
      });
    }

    return references;
  }

  private getMeaningfulPlaylistLines(playlistText: string): string[] {
    return playlistText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private resolvePlaylistReference(baseKey: string, reference: string): string {
    const cleanReference = reference.trim();

    if (/^https?:\/\//i.test(cleanReference)) {
      try {
        const url = new URL(cleanReference);
        return url.pathname.replace(/^\/+/, '');
      } catch {
        return cleanReference.replace(/^\/+/, '');
      }
    }

    if (cleanReference.startsWith('/')) {
      return cleanReference.replace(/^\/+/, '');
    }

    const baseDir = path.posix.dirname(baseKey);
    return path.posix
      .normalize(path.posix.join(baseDir, cleanReference))
      .replace(/^\/+/, '');
  }

  private normalizePrefix(prefix: string): string {
    return prefix.replace(/^\/+/, '').replace(/\/+$/, '').trim();
  }

  private validationError(reelId: string, technicalReason: string) {
    this.logger.error(
      `[Reel ${reelId}] Stream validation failed: ${technicalReason}`,
    );

    return new ReelStreamValidationError(
      SAFE_STREAM_VALIDATION_MESSAGE,
      technicalReason,
    );
  }
}
