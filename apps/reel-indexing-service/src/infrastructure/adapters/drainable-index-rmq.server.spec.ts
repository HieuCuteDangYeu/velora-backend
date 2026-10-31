import { ServerRMQ } from '@nestjs/microservices';
import { DrainableIndexRmqServer } from './drainable-index-rmq.server';

describe('job-only RMQ drain', () => {
  it('cancels consumption and waits for an in-flight job before reporting settled', async () => {
    let finish!: () => void;
    const handling = jest
      .spyOn(ServerRMQ.prototype, 'handleMessage')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const setup = jest
      .spyOn(ServerRMQ.prototype, 'setupChannel')
      .mockResolvedValue();
    const channel = { cancel: jest.fn().mockResolvedValue(undefined) };
    const server = new DrainableIndexRmqServer({ queue: 'jobs' });
    await server.setupChannel(channel as never, () => undefined);
    const job = server.handleMessage({}, channel as never);
    expect(await server.drain(0)).toBe(false);
    finish();
    await job;
    expect(await server.drain(0)).toBe(true);
    expect(channel.cancel).toHaveBeenCalled();
    setup.mockClear();
    await server.setupChannel(channel as never, () => undefined);
    expect(setup).not.toHaveBeenCalled();
    handling.mockRestore();
    setup.mockRestore();
  });
});
