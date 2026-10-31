import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  validateHlsArtifactGraph,
  type ReelHlsReplacementPlan,
} from '@common/content/reel-hls-replacement';
import type { IReelHlsArtifactValidator } from '@content/domain/interfaces/reel-hls-artifact-validator.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

@Injectable()
export class ReelHlsArtifactValidatorService implements IReelHlsArtifactValidator {
  private readonly client: S3Client;
  constructor(private readonly config: ConfigService) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.get<string>('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get<string>('R2_ACCESS_KEY_ID')!,
        secretAccessKey: config.get<string>('R2_SECRET_ACCESS_KEY')!,
      },
    });
  }
  async validate(plan: ReelHlsReplacementPlan): Promise<void> {
    const playlists = new Map<string, string>();
    for (const file of plan.files) {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.get<string>('R2_BUCKET_NAME'),
          Key: `reels/${plan.reelId}/${plan.attemptId}/${file.path}`,
        }),
      );
      if (!response.Body || response.ContentLength !== file.bytes)
        throw new Error('Staged HLS object length mismatch');
      const hash = createHash('sha256');
      let bytes = 0;
      const text: Buffer[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > file.bytes)
          throw new Error('Staged HLS object exceeds reviewed length');
        hash.update(chunk);
        if (file.path.endsWith('.m3u8')) {
          if (bytes > 2_097_152)
            throw new Error('Staged HLS playlist is too large');
          text.push(Buffer.from(chunk));
        }
      }
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256)
        throw new Error('Staged HLS checksum mismatch');
      if (file.path.endsWith('.m3u8'))
        playlists.set(file.path, Buffer.concat(text).toString('utf8'));
    }
    validateHlsArtifactGraph(plan, playlists);
  }
}
