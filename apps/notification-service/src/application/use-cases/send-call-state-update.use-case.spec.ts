import { SendCallStateUpdateUseCase } from './send-call-state-update.use-case';

describe('SendCallStateUpdateUseCase action privacy', () => {
  const baseInput = {
    recipientUserIds: ['guest'],
    conversationId: 'conversation',
    callId: 'call',
    status: 'active' as const,
    at: '2026-09-24T00:00:00.000Z',
  };

  const createHarness = () => {
    const create = jest.fn().mockResolvedValue({ id: 'job' });
    const process = {
      execute: jest.fn().mockResolvedValue({ sendResult: { results: [] } }),
    };
    const useCase = new SendCallStateUpdateUseCase(
      { create } as never,
      process as never,
    );
    return { create, useCase };
  };

  it('never stores a raw group action, even if an internal sender includes one', async () => {
    for (const answerActionHash of [undefined, 'a'.repeat(64)]) {
      const { create, useCase } = createHarness();
      await useCase.execute({
        ...baseInput,
        isGroupCall: true,
        answerActionId: 'raw-group-action',
        answerActionHash,
      });
      const saved = create.mock.calls[0][0] as {
        idempotencyKey: string;
        dataJson: Record<string, unknown>;
      };
      expect(saved.dataJson).not.toHaveProperty('answerActionId');
      expect(saved.idempotencyKey).not.toContain('raw-group-action');
      if (answerActionHash) {
        expect(saved.dataJson.answerActionHash).toBe(answerActionHash);
      }
    }
  });

  it('keeps the existing direct-call answer action when no hash is present', async () => {
    const { create, useCase } = createHarness();
    await useCase.execute({ ...baseInput, answerActionId: 'direct-action' });
    expect(create.mock.calls[0][0].dataJson.answerActionId).toBe(
      'direct-action',
    );
  });
});
