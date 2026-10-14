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

    for (const variantReference of variantReferences) {
      const variantText = await this.readPlaylistReference(variantReference);
      if (!variantText) {
        throw this.validationError(
          data.reelId,
          `variant playlist is missing or unreadable: ${variantReference.key}`,
        );
      }

      const segmentReferences = this.parseMediaSegmentReferences(
        variantReference.key,
        variantText,
      );
      if (segmentReferences.length === 0) {
        throw this.validationError(
          data.reelId,
          `variant playlist has no media segments: ${variantReference.key}`,
        );
      }

      const uriReferences = this.parseUriAttributeReferences(
        variantReference.key,
        variantText,
      );
      for (const reference of [...segmentReferences, ...uriReferences]) {
        if (!(await this.referenceExists(reference))) {
          throw this.validationError(
            data.reelId,
            `required HLS object is missing: ${reference.key}`,
          );
        }
      }
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
      `[Reel ${data.reelId}] Stream validation passed: master=${masterKey}, variants=${variantReferences.length}, thumbnail=${data.thumbnailKey}`,
    );
  }

  private async readRequiredPlaylist(
    reelId: string,
    key: string,
    reason: string,
  ): Promise<string> {
    const text = await this.readOptionalPlaylist({ line: key, key });

    if (!text) {
      throw this.validationError(reelId, `${reason}: ${key}`);
    }

    return text;
  }

  private async readOptionalPlaylist(
    reference: PlaylistReference,
  ): Promise<string | null> {
    try {
      if (
        /^https?:\/\//i.test(reference.line) ||
        /^https?:\/\//i.test(reference.key)
      ) {
        const response = await fetch(reference.key);
        if (!response.ok) return null;
        const text = await response.text();
        return text.trim().length > 0 ? text : null;
      }

      const exists = await this.mediaStorageService.objectExists(reference.key);

      if (!exists) {
        return null;
      }

      const text = await this.mediaStorageService.getObjectText(reference.key);
      const trimmed = text.trim();

      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private async readPlaylistReference(
    reference: PlaylistReference,
  ): Promise<string | null> {
    return this.readOptionalPlaylist(reference);
  }

  private async referenceExists(
    reference: PlaylistReference,
  ): Promise<boolean> {
    if (
      /^https?:\/\//i.test(reference.line) ||
      /^https?:\/\//i.test(reference.key)
    ) {
      try {
        const response = await fetch(reference.key, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
        });
        return response.ok || response.status === 206;
      } catch {
        return false;
      }
    }

    return this.mediaStorageService.objectExists(reference.key);
  }

  private parseVariantPlaylistReferences(
    masterKey: string,
    playlistText: string,
  ): PlaylistReference[] {
    const lines = this.getMeaningfulPlaylistLines(playlistText);
    const references: PlaylistReference[] = [];

    for (const line of lines) {
      for (const uri of this.parseUriAttributeValues(line)) {
        if (uri.toLowerCase().includes('.m3u8')) {
          references.push({
            line: uri,
            key: this.resolvePlaylistReference(masterKey, uri),
          });
        }
      }

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

    return this.uniqueReferences(references);
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

  private parseUriAttributeReferences(
    playlistKey: string,
    playlistText: string,
  ): PlaylistReference[] {
    return playlistText.split(/\r?\n/u).flatMap((line) =>
      this.parseUriAttributeValues(line).map((uri) => ({
        line: uri,
        key: this.resolvePlaylistReference(playlistKey, uri),
      })),
    );
  }

  private parseUriAttributeValues(line: string): string[] {
    const values: string[] = [];
    const pattern = /URI="([^"]+)"/giu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      values.push(match[1]);
    }
    return values;
  }

  private uniqueReferences(
    references: PlaylistReference[],
  ): PlaylistReference[] {
    const seen = new Set<string>();
    return references.filter((reference) => {
      const identity = `${reference.line}\u0000${reference.key}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
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
      return cleanReference;
    }

    if (/^https?:\/\//i.test(baseKey)) {
      try {
        return new URL(cleanReference, baseKey).toString();
      } catch {
        return cleanReference;
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
