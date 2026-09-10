import { MediasoupCallMediaEngine } from '../../../src/infrastructure/engines/mediasoup-call.engine';

type RouterDouble = {
  id: string;
  rtpCapabilities: { codecs: []; headerExtensions: [] };
  close: jest.Mock;
};

function createEngine(createRouter: jest.Mock) {
  const stateRepository = { saveRoom: jest.fn().mockResolvedValue(undefined) };
  const engine = new MediasoupCallMediaEngine(stateRepository as never);
  const worker = { pid: 1, createRouter };
  (engine as unknown as { workers: unknown[] }).workers.push(worker);

  return { engine, stateRepository };
}

const waitForRoomAllocation = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('MediasoupCallMediaEngine room creation', () => {
  it('coalesces concurrent room creation for an idempotent incoming-answer retry', async () => {
    const router: RouterDouble = {
      id: 'router-1',
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: jest.fn(),
    };
    let resolveRouter: (router: RouterDouble) => void = () => undefined;
    const createRouter = jest.fn(
      () =>
        new Promise<RouterDouble>((resolve) => {
          resolveRouter = resolve;
        }),
    );
    const { engine, stateRepository } = createEngine(createRouter);

    const first = engine.createRoom('call-1');
    const retry = engine.createRoom('call-1');
    await waitForRoomAllocation();
    expect(createRouter).toHaveBeenCalledTimes(1);

    resolveRouter(router);
    await expect(Promise.all([first, retry])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(stateRepository.saveRoom).toHaveBeenCalledTimes(1);
    expect(stateRepository.saveRoom).toHaveBeenCalledWith({
      callId: 'call-1',
      workerId: '1',
      routerId: 'router-1',
    });
  });

  it('allows a later retry after room creation fails', async () => {
    const router: RouterDouble = {
      id: 'router-2',
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: jest.fn(),
    };
    const createRouter = jest
      .fn()
      .mockRejectedValueOnce(new Error('worker unavailable'))
      .mockResolvedValueOnce(router);
    const { engine, stateRepository } = createEngine(createRouter);

    await expect(engine.createRoom('call-2')).rejects.toThrow(
      'worker unavailable',
    );
    await expect(engine.createRoom('call-2')).resolves.toBeUndefined();

    expect(createRouter).toHaveBeenCalledTimes(2);
    expect(stateRepository.saveRoom).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending creation before terminal cleanup closes the router', async () => {
    const router: RouterDouble = {
      id: 'router-3',
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: jest.fn(),
    };
    let resolveRouter: (router: RouterDouble) => void = () => undefined;
    const createRouter = jest.fn(
      () =>
        new Promise<RouterDouble>((resolve) => {
          resolveRouter = resolve;
        }),
    );
    const { engine } = createEngine(createRouter);

    const creation = engine.createRoom('call-3');
    const cleanup = engine.closeRoom('call-3');
    await waitForRoomAllocation();
    resolveRouter(router);

    await expect(Promise.all([creation, cleanup])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(router.close).toHaveBeenCalledTimes(1);
    expect(() => engine.getRouterRtpCapabilities('call-3')).toThrow(
      'Call room not found',
    );
  });
});
