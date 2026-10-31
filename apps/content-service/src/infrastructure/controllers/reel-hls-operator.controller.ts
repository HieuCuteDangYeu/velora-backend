import { ReelHlsReplacementPlanSchema } from '@common/content/reel-hls-replacement';
import { ReplaceReelHlsUseCase } from '@content/application/use-cases/replace-reel-hls.use-case';
import { GetReelHlsReplacementSnapshotUseCase } from '@content/application/use-cases/get-reel-hls-replacement-snapshot.use-case';
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { z } from 'zod';

const CommandSchema = z
  .object({
    action: z.enum(['RESERVE', 'APPLY', 'ROLLBACK']),
    plan: ReelHlsReplacementPlanSchema,
    reviewedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

// Internal RMQ only; deliberately has no gateway/HTTP route.
@Controller()
export class ReelHlsOperatorController {
  constructor(
    private readonly config: ConfigService,
    private readonly replace: ReplaceReelHlsUseCase,
    private readonly snapshot: GetReelHlsReplacementSnapshotUseCase,
  ) {}

  @MessagePattern('content.snapshot_reel_hls')
  async getSnapshot(@Payload() payload: unknown) {
    if (this.config.get<string>('REEL_HLS_REPLACEMENT_ENABLED') !== 'true')
      throw new RpcException('HLS replacement is disabled');
    const command = z.object({ reelId: z.uuid() }).strict().safeParse(payload);
    if (!command.success) throw new RpcException('Invalid Reel ID');
    return this.snapshot.execute(command.data.reelId);
  }

  @MessagePattern('content.replace_reel_hls')
  async execute(@Payload() payload: unknown) {
    if (this.config.get<string>('REEL_HLS_REPLACEMENT_ENABLED') !== 'true')
      throw new RpcException('HLS replacement is disabled');
    const command = CommandSchema.safeParse(payload);
    if (!command.success)
      throw new RpcException('Invalid HLS replacement command');
    try {
      return await this.replace.execute(command.data);
    } catch {
      throw new RpcException(
        'HLS replacement failed validation or lost its expected state; inspect and re-review before retrying',
      );
    }
  }
}
