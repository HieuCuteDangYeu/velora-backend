import { FinalizeUploadDto } from '@common/media/dtos/finalize-upload.dto';
import { GetPresignedUrlDto } from '@common/media/dtos/get-presigned-url.dto';
import { isRpcError } from '@common/constants/rpc-error.types';
import { Controller, ForbiddenException } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { FinalizeChatUploadUseCase } from '../../application/use-cases/finalize-chat-upload.use-case';
import { DeleteRecalledChatMediaUseCase } from '../../application/use-cases/delete-recalled-chat-media.use-case';
import { GetPresignedUrlUseCase } from '../../application/use-cases/get-presigned-url.use-case';

@Controller()
export class MediaController {
  constructor(
    private readonly getPresignedUrlUseCase: GetPresignedUrlUseCase,
    private readonly finalizeChatUploadUseCase: FinalizeChatUploadUseCase,
    private readonly deleteRecalledChatMediaUseCase: DeleteRecalledChatMediaUseCase,
  ) {}

  @MessagePattern('media.get_presigned_url')
  async handleGetPresignedUrl(
    @Payload() data: GetPresignedUrlDto & { userId: string },
  ) {
    try {
      return await this.getPresignedUrlUseCase.execute(
        data.userId,
        data.fileType,
        data.purpose,
        data.publishIntentId,
      );
    } catch (error) {
      if (isRpcError(error)) throw new RpcException(error);
      if (
        error instanceof Error &&
        (error.message.includes('Invalid file type') ||
          error.message.includes('publishIntentId'))
      ) {
        throw new RpcException({
          statusCode: 400,
          message: error.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal Server Error',
      });
    }
  }

  @MessagePattern('media.finalize_chat_upload')
  async handleFinalizeChatUpload(
    @Payload() data: FinalizeUploadDto & { userId: string },
  ) {
    try {
      return await this.finalizeChatUploadUseCase.execute(
        data.userId,
        data.key,
        data.fileType,
        data.thumbnailKey,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal Server Error';

      const statusCode =
        message === 'You are not allowed to finalize this upload.' ? 403 : 500;

      throw new RpcException({
        statusCode,
        message,
      });
    }
  }

  @MessagePattern('media.delete_recalled_chat_media')
  async handleDeleteRecalledChatMedia(
    @Payload() data: { userId: string; fileKeys: string[] },
  ): Promise<void> {
    try {
      await this.deleteRecalledChatMediaUseCase.execute(data);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal Server Error';
      const statusCode = error instanceof ForbiddenException ? 403 : 500;

      throw new RpcException({ statusCode, message });
    }
  }
}
