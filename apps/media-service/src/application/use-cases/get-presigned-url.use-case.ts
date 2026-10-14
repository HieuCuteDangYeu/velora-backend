import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { S3Service } from '../../infrastructure/services/s3.service';
import type { IReelUploadLeaseService } from '../../domain/interfaces/reel-upload-lease.service.interface';

@Injectable()
export class GetPresignedUrlUseCase {
  constructor(
    private readonly s3Service: S3Service,
    @Inject('IReelUploadLeaseService')
    private readonly reelUploadLeaseService: IReelUploadLeaseService,
  ) {}

  async execute(
    userId: string,
    fileType: string,
    purpose: 'avatar' | 'chat' | 'reel' | 'chat_thumbnail',
    publishIntentId?: string,
  ) {
    if (publishIntentId && purpose !== 'reel') {
      throw new Error('publishIntentId is only supported for reel uploads.');
    }
    if (
      publishIntentId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        publishIntentId,
      )
    ) {
      throw new Error('publishIntentId must be a UUID.');
    }
    const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];

    let folder = 'misc';

    if (purpose === 'avatar') {
      if (!allowedImageTypes.includes(fileType)) {
        throw new Error(
          'Invalid file type. Avatars must be JPEG, PNG, or WebP.',
        );
      }

      folder = 'avatars';
    } else if (purpose === 'reel') {
      if (!allowedVideoTypes.includes(fileType)) {
        throw new Error('Invalid file type. Reels must be MP4, WebM, or MOV.');
      }

      folder = 'reels';
    } else if (purpose === 'chat') {
      if (allowedImageTypes.includes(fileType)) {
        folder = 'chat-images';
      } else if (allowedVideoTypes.includes(fileType)) {
        folder = 'chat-videos';
      } else {
        throw new Error(
          'Invalid file type. Only JPEG, PNG, WebP, MP4, WebM, and MOV are allowed.',
        );
      }
    } else if (purpose === 'chat_thumbnail') {
      if (!allowedImageTypes.includes(fileType)) {
        throw new Error(
          'Invalid file type. Chat thumbnails must be JPEG, PNG, or WebP.',
        );
      }

      folder = 'chat-thumbnails';
    } else {
      throw new Error(
        'Invalid file type. Only JPEG, PNG, WebP, MP4, WebM, and MOV are allowed.',
      );
    }

    const reelUploadKey =
      purpose === 'reel' && publishIntentId
        ? this.s3Service.buildReelUploadKey(userId, fileType, publishIntentId)
        : undefined;

    if (reelUploadKey) {
      await this.reelUploadLeaseService.reserve({
        userId,
        publishIntentId: publishIntentId!,
        mediaKey: reelUploadKey,
        fileType,
        // Uploads can outlive the signed request's five-minute start window.
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    }

    const { uploadUrl, key } = await this.s3Service.generatePresignedUrl(
      userId,
      fileType,
      folder,
      publishIntentId,
    );

    return {
      uploadUrl,
      key,
      expiresIn: 300,
    };
  }
}
