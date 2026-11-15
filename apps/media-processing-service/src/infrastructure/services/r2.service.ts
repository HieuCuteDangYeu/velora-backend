import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import type {
  IMediaStorageService,
  StoredArtifact,
  UploadedThumbnail,
} from '@processing/domain/interfaces/media-storage.service.interface';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type UploadFile = {
  absolutePath: string;
  relativeKey: string;
};

const HLS_PLAYLIST_CACHE_CONTROL =
  'public, max-age=60, stale-while-revalidate=30';

const IMMUTABLE_MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const getContentType = (fileName: string): string => {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith('.m3u8')) {
    return 'application/vnd.apple.mpegurl';
  }

  if (lowerName.endsWith('.ts')) {
    return 'video/mp2t';
  }

  if (lowerName.endsWith('.m4s')) {
    return 'video/iso.segment';
  }

  if (lowerName.endsWith('.mp4')) {
    return 'video/mp4';
  }

  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (lowerName.endsWith('.png')) {
    return 'image/png';
  }

  if (lowerName.endsWith('.wav')) {
    return 'audio/wav';
  }

  if (lowerName.endsWith('.flac')) {
    return 'audio/flac';
  }

  if (lowerName.endsWith('.ogg')) {
    return 'audio/ogg';
  }

  if (lowerName.endsWith('.json')) {
    return 'application/json';
  }

  return 'application/octet-stream';
};

const getCacheControl = (fileName: string): string => {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith('.m3u8')) {
    return HLS_PLAYLIST_CACHE_CONTROL;
  }

  return IMMUTABLE_MEDIA_CACHE_CONTROL;
};

@Injectable()
export class R2Service implements IMediaStorageService {
  private readonly s3Client: S3Client;
  private readonly bucketName = process.env.R2_BUCKET_NAME!;
  private readonly publicDomain = process.env.R2_PUBLIC_DOMAIN!.replace(
    /\/+$/,
    '',
  );

  constructor() {
    const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      requestHandler: new NodeHttpHandler({
        httpsAgent: new https.Agent({ family: 4 }),
      }),
    });
  }

  async downloadVideo(key: string, downloadPath: string): Promise<void> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: this.normalizeKey(key),
    });

    const response = await this.s3Client.send(command);

    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });

    if (response.Body) {
      await pipeline(
        response.Body as NodeJS.ReadableStream,
        fs.createWriteStream(downloadPath),
      );
    }
  }

  async deleteObjectsByPrefix(prefix: string): Promise<void> {
    const cleanPrefix = prefix.replace(/^\/+/, '').trim();

    if (!cleanPrefix) {
      return;
    }

    const keys = await this.listObjectKeys(`${cleanPrefix}/`);

    if (keys.length === 0) {
      return;
    }

    for (let index = 0; index < keys.length; index += 1000) {
      const chunk = keys.slice(index, index + 1000);

      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: chunk.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  async uploadHlsDirectory(localDir: string, s3Prefix: string): Promise<void> {
    const files = this.listFilesRecursively(localDir);
    const cleanPrefix = this.normalizeKey(s3Prefix).replace(/\/+$/, '');

    await this.uploadWithConcurrency(files, 8, async (file) => {
      const fileStream = fs.createReadStream(file.absolutePath);
      const normalizedRelativeKey = file.relativeKey.split(path.sep).join('/');

      const key = `${cleanPrefix}/${normalizedRelativeKey}`;
      const fileName = path.basename(file.absolutePath);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileStream,
        ContentType: getContentType(fileName),
        CacheControl: getCacheControl(fileName),
      });

      await this.s3Client.send(command);
    });
  }

  async uploadThumbnail(
    localPath: string,
    s3Key: string,
  ): Promise<UploadedThumbnail> {
    const uploaded = await this.uploadArtifact(localPath, s3Key, 'image/jpeg');

    return {
      key: uploaded.key,
      url: this.getPublicUrl(uploaded.key),
    };
  }

  async uploadArtifact(
    localPath: string,
    s3Key: string,
    contentType: string,
  ): Promise<{ key: string; byteLength: number }> {
    const cleanKey = this.normalizeKey(s3Key);
    const byteLength = fs.statSync(localPath).size;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: cleanKey,
        Body: fs.createReadStream(localPath),
        ContentType: contentType,
        CacheControl: IMMUTABLE_MEDIA_CACHE_CONTROL,
      }),
    );

    return { key: cleanKey, byteLength };
  }

  async uploadTextObject(
    s3Key: string,
    content: string,
    contentType: string,
  ): Promise<StoredArtifact> {
    const cleanKey = this.normalizeKey(s3Key);
    const body = Buffer.from(content, 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: cleanKey,
        Body: body,
        ContentType: contentType,
        CacheControl: IMMUTABLE_MEDIA_CACHE_CONTROL,
      }),
    );

    return {
      key: cleanKey,
      byteLength: body.length,
      checksum,
    };
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: this.normalizeKey(key),
        }),
      );

      return true;
    } catch {
      return false;
    }
  }

  async getObjectText(key: string): Promise<string> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: this.normalizeKey(key),
      }),
    );

    if (!response.Body) {
      return '';
    }

    return this.streamToString(response.Body);
  }

  getPublicUrl(key: string): string {
    const normalizedKey = this.normalizeKey(key);
    return `${this.publicDomain}/${normalizedKey}`;
  }

  private normalizeKey(key: string): string {
    return key.replace(/^\/+/, '').trim();
  }

  private async streamToString(body: unknown): Promise<string> {
    if (!body) {
      return '';
    }

    if (typeof body === 'string') {
      return body;
    }

    if (
      typeof body === 'object' &&
      body !== null &&
      'transformToString' in body &&
      typeof (body as { transformToString?: unknown }).transformToString ===
        'function'
    ) {
      return await (
        body as { transformToString: () => Promise<string> }
      ).transformToString();
    }

    const readable =
      body instanceof Readable
        ? body
        : Readable.from(
            body as Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
          );

    const chunks: Uint8Array[] = [];

    for await (const chunk of readable as AsyncIterable<unknown>) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
        continue;
      }

      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
        continue;
      }

      if (chunk instanceof ArrayBuffer) {
        chunks.push(new Uint8Array(chunk));
        continue;
      }

      chunks.push(Buffer.from(String(chunk), 'utf8'));
    }

    return Buffer.concat(chunks).toString('utf8');
  }

  private async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const object of response.Contents ?? []) {
        if (object.Key) {
          keys.push(object.Key);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  private listFilesRecursively(directory: string): UploadFile[] {
    const files: UploadFile[] = [];

    const walk = (currentDirectory: string) => {
      const entries = fs.readdirSync(currentDirectory, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        const absolutePath = path.join(currentDirectory, entry.name);

        if (entry.isDirectory()) {
          walk(absolutePath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        files.push({
          absolutePath,
          relativeKey: path.relative(directory, absolutePath),
        });
      }
    };

    walk(directory);

    return files;
  }

  private async uploadWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    const executing = new Set<Promise<void>>();

    for (const item of items) {
      const promise = worker(item).finally(() => {
        executing.delete(promise);
      });

      executing.add(promise);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
  }
}
