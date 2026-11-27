import { GetReelAskQuestionsUseCase } from '@content/application/use-cases/get-reel-ask-questions.use-case';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { z } from 'zod';

const request = z
  .object({
    reelId: z.string().trim().min(1).max(256),
    viewerId: z.string().trim().min(1).max(256),
    isAdmin: z.boolean().optional(),
  })
  .strict();

@Controller()
export class ReelAskQuestionsController {
  constructor(
    private readonly getReelAskQuestions: GetReelAskQuestionsUseCase,
  ) {}

  @MessagePattern('content.get_reel_ask_questions')
  async get(@Payload() data: unknown) {
    const parsed = request.safeParse(data);
    if (!parsed.success) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid reel questions request',
      });
    }
    const result = await this.getReelAskQuestions.execute(parsed.data);
    if (!result) {
      throw new RpcException({ statusCode: 404, message: 'Reel not found' });
    }
    return result;
  }
}
