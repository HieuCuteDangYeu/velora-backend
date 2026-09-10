import { CallAnswerOutboxWorker } from '../../../src/infrastructure/workers/call-answer-outbox.worker';

describe('CallAnswerOutboxWorker', () => {
  it('does not drain a call answer event after the runtime lease is lost', async () => {
    const publishOutbox = { execute: jest.fn().mockResolvedValue(1) };
    const runtimeLease = {
      acquire: jest.fn(),
      assertHeld: jest.fn(() => {
        throw new Error('Call runtime lease is not held');
      }),
    };
    const worker = new CallAnswerOutboxWorker(
      publishOutbox as never,
      runtimeLease as never,
    );

    await worker.drain();

    expect(runtimeLease.assertHeld).toHaveBeenCalledTimes(1);
    expect(publishOutbox.execute).not.toHaveBeenCalled();
  });

  it('rechecks ownership between outbox batches', async () => {
    const publishOutbox = {
      execute: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
    };
    const runtimeLease = { acquire: jest.fn(), assertHeld: jest.fn() };
    const worker = new CallAnswerOutboxWorker(
      publishOutbox as never,
      runtimeLease as never,
    );

    await worker.drain();

    expect(publishOutbox.execute).toHaveBeenCalledTimes(2);
    expect(runtimeLease.assertHeld).toHaveBeenCalledTimes(2);
  });
});
