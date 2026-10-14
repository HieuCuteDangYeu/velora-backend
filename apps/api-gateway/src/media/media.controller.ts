import { isRpcError } from '@common/constants/rpc-error.types';
import { FinalizeUploadDto } from '@common/media/dtos/finalize-upload.dto';
import { GetPresignedUrlDto } from '@common/media/dtos/get-presigned-url.dto';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '@gateway/auth/guards/jwt-auth.guard';
import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { catchError, lastValueFrom } from 'rxjs';

@ApiTags('Media')
@Controller('media')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MediaController {
  constructor(
    @Inject('MEDIA_SERVICE') private readonly mediaClient: ClientProxy,
  ) {}

  @Post('upload-url')
  @ApiOperation({ summary: 'Get a pre-signed URL to upload' })
  async getUploadUrl(
    @Req() request: AuthenticatedRequest,
    @Body() body: GetPresignedUrlDto,
  ) {
    return await lastValueFrom(
      this.mediaClient
        .send<{
          uploadUrl: string;
          key: string;
          expiresIn: number;
        }>('media.get_presigned_url', {
          userId: request.user!.id,
          fileType: body.fileType,
          purpose: body.purpose,
          publishIntentId: body.publishIntentId,
        })
        .pipe(
          catchError((error) => {
            this.handleMicroserviceError(error);
          }),
        ),
    );
  }

  @Post('finalize-upload')
  @ApiOperation({
    summary: 'Finalize uploaded chat media and return CDN metadata',
  })
  async finalizeUpload(
    @Req() request: AuthenticatedRequest,
    @Body() body: FinalizeUploadDto,
  ) {
    return await lastValueFrom(
      this.mediaClient
        .send<{
          fileKey: string;
          fileUrl: string;
          thumbnailKey?: string;
          thumbnailUrl?: string;
          mimeType: string;
          width?: number;
          height?: number;
          durationMs?: number;
          status: 'ready' | 'processing' | 'failed';
          failureReason?: string;
        }>('media.finalize_chat_upload', {
          userId: request.user!.id,
          key: body.key,
          thumbnailKey: body.thumbnailKey,
          fileType: body.fileType,
        })
        .pipe(
          catchError((error) => {
            this.handleMicroserviceError(error);
          }),
        ),
    );
  }

  private handleMicroserviceError(error: any): never {
    if (isRpcError(error)) {
      throw new HttpException(error.message, error.statusCode);
    }

    throw new HttpException(
      'Internal Server Error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
