import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { pipeline } from 'stream/promises';

@Injectable()
export class S3Service {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly publicDomain: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.getOrThrow<string>('R2_BUCKET_NAME');
    this.publicDomain = this.configService
      .getOrThrow<string>('R2_PUBLIC_DOMAIN')
      .replace(/\/+$/, '');
    const accountId = this.configService.getOrThrow<string>('R2_ACCOUNT_ID');

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>(
          'R2_SECRET_ACCESS_KEY',
        ),
      },
    });
  }

  async generatePresignedUrl(
    userId: string,
    contentType: string,
    folder: string = 'avatars',
    publishIntentId?: string,
  ) {
    try {
      const key =
        folder === 'reels' && publishIntentId
          ? this.buildReelUploadKey(userId, contentType, publishIntentId)
          : this.buildRandomUploadKey(userId, contentType, folder);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
        ...(folder === 'reels' && publishIntentId ? { IfNoneMatch: '*' } : {}),
      });

      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 300,
      });

      return {
        uploadUrl,
        key,
      };
    } catch (error) {
      console.error('S3 Presign Error:', error);
      throw new InternalServerErrorException('Failed to generate upload URL');
    }
  }

  buildReelUploadKey(
    userId: string,
    contentType: string,
    publishIntentId: string,
  ): string {
    return `reels/${userId}/${publishIntentId}.${this.fileExtension(contentType)}`;
  }

  private buildRandomUploadKey(
    userId: string,
    contentType: string,
    folder: string,
  ): string {
    return `${folder}/${userId}/${randomUUID()}.${this.fileExtension(contentType)}`;
  }

  private fileExtension(contentType: string): string {
    return contentType.split('/')[1];
  }

  getPublicUrl(key: string) {
    const normalizedKey = key.replace(/^\/+/, '');
    return `${this.publicDomain}/${normalizedKey}`;
  }

  async deleteObjects(keys: string[]): Promise<void> {
    const normalizedKeys = [
      ...new Set(
        keys
          .map((key) => key.replace(/^\/+/, '').trim())
          .filter((key) => key.length > 0),
      ),
    ];

    if (normalizedKeys.length === 0) {
      return;
    }

    const response = await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucketName,
        Delete: {
          Objects: normalizedKeys.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );

    if (response.Errors?.length) {
      throw new InternalServerErrorException(
        'Could not delete all media objects',
      );
    }
  }

  async downloadObjectToFile(key: string, outputPath: string) {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    const response = await this.s3Client.send(command);
    const body = response.Body;

    if (!body || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
      throw new InternalServerErrorException('Downloaded media body is empty');
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await pipeline(
      body as NodeJS.ReadableStream,
      createWriteStream(outputPath),
    );
  }

  async uploadFile(filePath: string, key: string, contentType: string) {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
      Body: createReadStream(filePath),
    });

    await this.s3Client.send(command);

    return {
      key,
      url: this.getPublicUrl(key),
    };
  }
}
