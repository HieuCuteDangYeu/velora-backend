import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'stream';
import { buffer } from 'stream/consumers';
import { ChatImageUnreadableError } from '../../domain/errors/chat-image-unreadable.error';
import type { IChatImageStorageService } from '../../domain/interfaces/chat-image-storage.service.interface';

@Injectable()
export class R2ChatImageStorageService implements IChatImageStorageService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.getOrThrow<string>('R2_BUCKET_NAME');
    const accountId = this.configService.getOrThrow<string>('R2_ACCOUNT_ID');

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>(
          'R2_SECRET_ACCESS_KEY',
        ),
      },
      forcePathStyle: true,
    });
  }

  async downloadImage(key: string, maxBytes: number): Promise<Buffer> {
    let response: GetObjectCommandOutput;
    try {
      response = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new ChatImageUnreadableError('NOT_FOUND');
      }
      throw error;
    }

    if (!response.Body) throw new ChatImageUnreadableError('NOT_FOUND');
    if (
      response.ContentLength !== undefined &&
      response.ContentLength > maxBytes
    ) {
      throw new ChatImageUnreadableError('TOO_LARGE');
    }

    const image = await buffer(response.Body as Readable);
    if (image.length === 0) throw new ChatImageUnreadableError('NOT_FOUND');
    if (image.length > maxBytes)
      throw new ChatImageUnreadableError('TOO_LARGE');
    return image;
  }
}
