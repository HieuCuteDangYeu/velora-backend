import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { TranscriptionAudioManifest } from '@common/processing/interfaces/transcription-audio-manifest.interface';
import type { VisualFrameManifest } from '@common/processing/interfaces/visual-frame-manifest.interface';
import type { IArtifactStorage } from '@indexing/domain/interfaces/artifact-storage.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

@Injectable()
export class R2ArtifactStorageAdapter implements IArtifactStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>('R2_BUCKET_NAME');
    const accountId = configService.getOrThrow<string>('R2_ACCOUNT_ID');

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: configService.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: configService.getOrThrow<string>(
          'R2_SECRET_ACCESS_KEY',
        ),
      },
      forcePathStyle: true,
    });
  }

  async getTranscriptionAudioManifest(
    key: string,
  ): Promise<TranscriptionAudioManifest> {
    const value = await this.getJsonObject(key);

    if (!this.isTranscriptionManifest(value)) {
      throw new Error(`Transcription audio manifest ${key} is invalid`);
    }

    return value;
  }

  async getVisualFrameManifest(key: string): Promise<VisualFrameManifest> {
    const value = await this.getJsonObject(key);

    if (!this.isVisualFrameManifest(value)) {
      throw new Error(`Visual frame manifest ${key} is invalid`);
    }

    return value;
  }

  async getArtifactBytes(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`Artifact ${key} was not found`);
    }

    return await response.Body.transformToByteArray();
  }

  async getVerifiedArtifactBytes(input: {
    key: string;
    sha256: string;
  }): Promise<Uint8Array> {
    const bytes = await this.getArtifactBytes(input.key);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== input.sha256.trim().toLowerCase()) {
      throw new Error(`Artifact ${input.key} checksum mismatch`);
    }
    return bytes;
  }

  async putVerifiedArtifact(input: {
    key: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<void> {
    if (
      !input.key.startsWith('reel-indexing/') ||
      input.key
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      input.bytes.byteLength > 64 * 1024 * 1024
    )
      throw new Error('Invalid Reel Indexing artifact');
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    if (sha256 !== input.sha256.toLowerCase())
      throw new Error('Reel Indexing artifact checksum mismatch');
    if (await this.artifactExists(input.key)) {
      const existing = await this.getVerifiedArtifactBytes({
        key: input.key,
        sha256,
      });
      if (!Buffer.from(existing).equals(Buffer.from(input.bytes)))
        throw new Error('Reel Indexing artifact key collision');
      return;
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentType: 'application/json',
        CacheControl: 'no-store',
        Metadata: { sha256 },
      }),
    );
    await this.getVerifiedArtifactBytes({ key: input.key, sha256 });
  }

  async deleteArtifact(key: string): Promise<void> {
    if (
      !key.startsWith('reel-indexing/') ||
      key.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid Reel Indexing artifact key');
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async artifactExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error: unknown) {
      const metadata =
        typeof error === 'object' && error !== null && '$metadata' in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          : undefined;
      if (metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }

  private async getJsonObject(key: string): Promise<unknown> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`Artifact ${key} was not found`);
    }

    return JSON.parse(await response.Body.transformToString('utf8')) as unknown;
  }

  private isTranscriptionManifest(
    value: unknown,
  ): value is TranscriptionAudioManifest {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record['reelId'] === 'string' &&
      typeof record['mediaAttemptId'] === 'string' &&
      typeof record['totalDurationMs'] === 'number' &&
      (record['format'] === 'wav' || record['format'] === 'flac') &&
      record['version'] === 1 &&
      Array.isArray(record['artifacts']) &&
      record['artifacts'].every((artifact) => {
        if (typeof artifact !== 'object' || artifact === null) return false;
        const item = artifact as Record<string, unknown>;
        return (
          typeof item['key'] === 'string' &&
          typeof item['startMs'] === 'number' &&
          typeof item['endMs'] === 'number' &&
          typeof item['overlapBeforeMs'] === 'number' &&
          typeof item['checksum'] === 'string' &&
          typeof item['byteLength'] === 'number'
        );
      })
    );
  }

  private isVisualFrameManifest(value: unknown): value is VisualFrameManifest {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record['reelId'] === 'string' &&
      typeof record['mediaAttemptId'] === 'string' &&
      typeof record['totalDurationMs'] === 'number' &&
      record['version'] === 1 &&
      typeof record['sampling'] === 'object' &&
      record['sampling'] !== null &&
      Array.isArray(record['artifacts']) &&
      record['artifacts'].every((artifact) => {
        if (typeof artifact !== 'object' || artifact === null) return false;
        const item = artifact as Record<string, unknown>;
        return (
          typeof item['key'] === 'string' &&
          typeof item['timestampMs'] === 'number' &&
          typeof item['checksum'] === 'string' &&
          typeof item['byteLength'] === 'number' &&
          ['PERIODIC', 'SCENE_CHANGE', 'PERIODIC_AND_SCENE_CHANGE'].includes(
            String(item['reason']),
          )
        );
      })
    );
  }
}
