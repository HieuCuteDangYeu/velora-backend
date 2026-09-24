import { DispatchOutboxEventsUseCase } from './dispatch-outbox-events.use-case';

describe('DispatchOutboxEventsUseCase', () => {
  it('claims events against the same app clock used for outbox scheduling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
    const claimPending = jest.fn().mockResolvedValue([]);
    const useCase = new DispatchOutboxEventsUseCase(
      { claimPending } as never,
      {} as never,
      {} as never,
    );

    await useCase.execute({ batchSize: 25, staleClaimMs: 60_000 });

    expect(claimPending).toHaveBeenCalledWith({
      limit: 25,
      claimToken: expect.any(String),
      dueBefore: new Date('2026-09-24T10:00:00.000Z'),
      staleBefore: new Date('2026-09-24T09:59:00.000Z'),
    });

    jest.useRealTimers();
  });
});
