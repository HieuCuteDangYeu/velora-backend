import { MemoryWriterAgentUseCase } from '@ai/application/use-cases/memory-writer-agent.use-case';
import type { ConversationTurnCompletedPayload } from '@common/ai/interfaces/user-memory.interface';
import { RefuseRagInputUseCase } from '@ai/application/use-cases/refuse-rag-input.use-case';
import { Injectable, Optional } from '@nestjs/common';

@Injectable()
export class HandleConversationTurnCompletedUseCase {
  constructor(
    private readonly memoryWriterAgentUseCase: MemoryWriterAgentUseCase,
    @Optional()
    private readonly refuseRagInputUseCase?: RefuseRagInputUseCase,
  ) {}

  async execute(payload: ConversationTurnCompletedPayload): Promise<void> {
    if (
      !payload.userId ||
      !payload.conversationId ||
      !payload.userMessage?.trim() ||
      !payload.assistantMessage?.trim()
    ) {
      return;
    }

    // A turn the input check refused must not be summarised or remembered, or the
    // refused text would come back through memory on a later turn.
    if (this.wasRefused(payload.userMessage)) {
      return;
    }

    await this.memoryWriterAgentUseCase.execute(payload);
  }

  private wasRefused(message: string): boolean {
    return this.refuseRagInputUseCase?.execute({ message }).refuse ?? false;
  }
}
