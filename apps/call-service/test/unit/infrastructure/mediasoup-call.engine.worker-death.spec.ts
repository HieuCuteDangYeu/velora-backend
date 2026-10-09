import { MediasoupCallMediaEngine } from '../../../src/infrastructure/engines/mediasoup-call.engine';

/**
 * Real mediasoup worker process, killed from the outside. The unit specs use
 * doubles; this proves the actual 'died' event reaches the engine and that the
 * engine heals itself.
 */
// Production uses one fixed WebRtcServer UDP port, which the respawned worker
// must be able to bind again; the port-range mode covers the default setup.
describe.each([
  ['port range', undefined],
  ['single WebRtcServer port', '40731'],
])('MediasoupCallMediaEngine real worker death (%s)', (_mode, serverPort) => {
  const stateRepository = {
    saveRoom: jest.fn().mockResolvedValue(undefined),
    removeRoomIfRouterId: jest.fn().mockResolvedValue(undefined),
    clearCallState: jest.fn().mockResolvedValue(undefined),
  };
  let engine: MediasoupCallMediaEngine;

  beforeEach(async () => {
    if (serverPort) process.env.MEDIASOUP_WEBRTC_SERVER_PORT = serverPort;
    else delete process.env.MEDIASOUP_WEBRTC_SERVER_PORT;
    process.env.MEDIASOUP_WORKERS = '1';
    engine = new MediasoupCallMediaEngine(stateRepository as never);
    await engine.onModuleInit();
  });

  afterEach(async () => {
    await engine.onModuleDestroy();
    delete process.env.MEDIASOUP_WEBRTC_SERVER_PORT;
  });

  const workerPid = async (): Promise<number> => {
    const [load] = await engine.getWorkerLoad();
    const workers = (engine as unknown as { workers: Array<{ pid: number }> })
      .workers;
    expect(load).toBeDefined();
    return workers[0].pid;
  };

  it('drops the rooms on the killed worker, reports them, and serves new calls on a respawned worker', async () => {
    await engine.createRoom('call-1');
    await engine.createRoom('call-2');
    const lost = new Promise<string[]>((resolve) =>
      engine.onRoomsLost(resolve),
    );
    const pidBefore = await workerPid();

    process.kill(pidBefore, 'SIGKILL');

    await expect(lost).resolves.toEqual(['call-1', 'call-2']);
    expect(() => engine.getRouterRtpCapabilities('call-1')).toThrow(
      'Call room not found',
    );

    // A new call must work without any manual restart.
    await engine.createRoom('call-3');
    await expect(
      engine.getRouterRtpCapabilities('call-3'),
    ).resolves.toBeDefined();
    expect(await workerPid()).not.toBe(pidBefore);
    await expect(engine.getWorkerLoad()).resolves.toEqual([
      expect.objectContaining({ worker: '0', rooms: 1 }),
    ]);
  }, 20_000);
});
