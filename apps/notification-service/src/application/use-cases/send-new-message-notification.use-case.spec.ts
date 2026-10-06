import type { INotificationJobRepository } from '../../domain/interfaces/notification-job.repository.interface';
import { SendNewMessageNotificationUseCase } from './send-new-message-notification.use-case';

const input = {
  recipientUserIds: ['member', 'third', 'member'],
  actorUserId: 'actor',
  conversationId: 'conversation',
  messageId: 'message',
  title: 'Core Team',
  body: 'Alice: Hello',
};

describe('SendNewMessageNotificationUseCase', () => {
  it('acknowledges only a committed batch, without inline push delivery', async () => {
    let commit!: (count: number) => void;
    const repository = {
      enqueueMany: jest.fn(
        () =>
          new Promise<number>((resolve) => {
            commit = resolve;
          }),
      ),
    };
    const useCase = new SendNewMessageNotificationUseCase(
      repository as unknown as INotificationJobRepository,
    );
    const settled = jest.fn();
    const pending = useCase.execute(input).then((value) => {
      settled();
      return value;
    });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(repository.enqueueMany).toHaveBeenCalledTimes(1);
    const jobs = repository.enqueueMany.mock.calls[0][0];
    expect(jobs).toEqual(
      ['member', 'third'].map((recipientUserId) => ({
        type: 'NEW_MESSAGE',
        recipientUserId,
        actorUserId: 'actor',
        conversationId: 'conversation',
        messageId: 'message',
        title: 'Core Team',
        body: 'Alice: Hello',
        dataJson: { type: 'NEW_MESSAGE' },
        idempotencyKey: `new-message:${JSON.stringify(['conversation', 'message', recipientUserId])}`,
      })),
    );
    commit(2);
    await expect(pending).resolves.toEqual({
      recipientCount: 2,
      createdCount: 2,
      status: 'queued',
    });
  });

  it('normalizes recipients and keeps replay identity independent of title/body', async () => {
    const repository = { enqueueMany: jest.fn().mockResolvedValue(0) };
    const useCase = new SendNewMessageNotificationUseCase(repository as never);
    await useCase.execute({
      ...input,
      recipientUserIds: [' member ', 'member', ''],
    });
    await useCase.execute({
      ...input,
      recipientUserIds: ['member'],
      title: 'Updated',
    });
    expect(repository.enqueueMany.mock.calls[0][0]).toHaveLength(1);
    expect(repository.enqueueMany.mock.calls[0][0][0].idempotencyKey).toEqual(
      repository.enqueueMany.mock.calls[1][0][0].idempotencyKey,
    );
    const result = await useCase.execute({
      ...input,
      recipientUserIds: ['', '   '],
    });
    expect(result).toEqual({
      recipientCount: 0,
      createdCount: 0,
      status: 'queued',
    });
  });

  it('propagates persistence failure instead of returning a false acceptance', async () => {
    const repository = {
      enqueueMany: jest
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
    };
    const useCase = new SendNewMessageNotificationUseCase(repository as never);
    await expect(useCase.execute(input)).rejects.toThrow(
      'database unavailable',
    );
  });
});
