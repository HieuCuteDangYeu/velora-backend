import { MediasoupCallMediaEngine } from '../../../src/infrastructure/engines/mediasoup-call.engine';

type RouterDouble = {
  id: string;
  rtpCapabilities: { codecs: []; headerExtensions: [] };
  close: jest.Mock;
};

function createEngine(createRouter: jest.Mock) {
  const stateRepository = {
    saveRoom: jest.fn().mockResolvedValue(undefined),
    saveTransportState: jest.fn().mockResolvedValue(undefined),
    saveProducerState: jest.fn().mockResolvedValue(undefined),
    removeProducerState: jest.fn().mockResolvedValue(undefined),
  };
  const engine = new MediasoupCallMediaEngine(stateRepository as never);
  const worker = { pid: 1, createRouter };
  (engine as unknown as { workers: unknown[] }).workers.push(worker);

  return { engine, stateRepository, worker };
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

describe('MediasoupCallMediaEngine producer lifecycle', () => {
  const createConnectedEngine = async () => {
    const producer = {
      id: 'producer-1',
      on: jest.fn(),
      close: jest.fn(),
    };
    const transport = {
      id: 'transport-1',
      produce: jest.fn().mockResolvedValue(producer),
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      on: jest.fn(),
      observer: { on: jest.fn() },
    };
    const router = {
      id: 'router-producer',
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: jest.fn(),
      createWebRtcTransport: jest.fn().mockResolvedValue(transport),
    };
    const createRouter = jest.fn().mockResolvedValue(router);
    const result = createEngine(createRouter);
    await result.engine.createRoom('call-producer');
    await result.engine.createSendTransport('call-producer', 'user-a');
    await result.engine.connectTransport(
      'call-producer',
      'user-a',
      'transport-1',
      {},
    );
    return { ...result, producer, transport };
  };

  it('returns the same producer for an idempotent request and rejects a second active kind', async () => {
    const { engine, transport } = await createConnectedEngine();

    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-1',
        'video',
        {},
        'request-1',
      ),
    ).resolves.toEqual({ producerId: 'producer-1' });
    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-1',
        'video',
        {},
        'request-1',
      ),
    ).resolves.toEqual({ producerId: 'producer-1' });
    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-1',
        'video',
        {},
        'request-2',
      ),
    ).rejects.toThrow('Media producer already exists');
    expect(transport.produce).toHaveBeenCalledTimes(1);
  });

  it('treats cleanup for an already removed producer as idempotent', async () => {
    const { engine } = await createConnectedEngine();

    await expect(
      engine.closeProducer('call-producer', 'user-a', 'producer-missing'),
    ).resolves.toEqual({ closed: false });
  });

  it('rolls back an in-memory producer when durable state persistence fails', async () => {
    const { engine, stateRepository, producer } = await createConnectedEngine();
    const persistenceError = new Error('redis unavailable');
    stateRepository.saveProducerState.mockRejectedValueOnce(persistenceError);

    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-1',
        'video',
        {},
        'request-persist-failure',
      ),
    ).rejects.toThrow(persistenceError);

    expect(producer.close).toHaveBeenCalledTimes(1);
    await expect(engine.listActiveProducers('call-producer')).resolves.toEqual(
      [],
    );
    expect(stateRepository.removeProducerState).toHaveBeenCalledWith(
      'call-producer',
      'user-a',
      'producer-1',
    );
  });

  it('coalesces concurrent producer creation before enforcing uniqueness', async () => {
    const { engine, transport, producer } = await createConnectedEngine();
    let resolveProduce: (value: typeof producer) => void = () => undefined;
    transport.produce.mockImplementationOnce(
      () => new Promise((resolve) => (resolveProduce = resolve)),
    );

    const first = engine.produce(
      'call-producer',
      'user-a',
      'transport-1',
      'video',
      {},
      'request-1',
    );
    const second = engine.produce(
      'call-producer',
      'user-a',
      'transport-1',
      'video',
      {},
      'request-2',
    );
    await Promise.resolve();
    expect(transport.produce).toHaveBeenCalledTimes(1);

    resolveProduce(producer);
    await expect(first).resolves.toEqual({ producerId: 'producer-1' });
    await expect(second).rejects.toThrow('Media producer already exists');
  });

  it('returns the pending producer to a retry with the same request id', async () => {
    const { engine, transport, producer } = await createConnectedEngine();
    let resolveProduce: (value: typeof producer) => void = () => undefined;
    transport.produce.mockImplementationOnce(
      () => new Promise((resolve) => (resolveProduce = resolve)),
    );

    const first = engine.produce(
      'call-producer',
      'user-a',
      'transport-1',
      'video',
      {},
      'request-retry',
    );
    const retry = engine.produce(
      'call-producer',
      'user-a',
      'transport-1',
      'video',
      {},
      'request-retry',
    );
    await Promise.resolve();
    expect(transport.produce).toHaveBeenCalledTimes(1);

    resolveProduce(producer);
    await expect(Promise.all([first, retry])).resolves.toEqual([
      { producerId: 'producer-1' },
      { producerId: 'producer-1' },
    ]);
  });

  it('replaces a producer left on an old send transport during a media rebuild', async () => {
    const { engine, transport, producer } = await createConnectedEngine();
    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-1',
        'video',
        {},
        'request-initial',
      ),
    ).resolves.toEqual({ producerId: 'producer-1' });

    const replacementProducer = {
      id: 'producer-2',
      on: jest.fn(),
      close: jest.fn(),
    };
    const replacementTransport = {
      ...transport,
      id: 'transport-2',
      produce: jest.fn().mockResolvedValue(replacementProducer),
    };
    const room = (
      engine as unknown as { rooms: Map<string, unknown> }
    ).rooms.get('call-producer') as {
      router: { createWebRtcTransport: jest.Mock };
    };
    room.router.createWebRtcTransport.mockResolvedValueOnce(
      replacementTransport,
    );

    await engine.createSendTransport('call-producer', 'user-a');
    await engine.connectTransport('call-producer', 'user-a', 'transport-2', {});

    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-2',
        'video',
        {},
        'request-rebuild',
      ),
    ).resolves.toEqual({
      producerId: 'producer-2',
      replacedProducerId: 'producer-1',
    });
    expect(producer.close).toHaveBeenCalledTimes(1);
    expect(() => engine.listActiveProducers('call-producer')).not.toThrow();
    await expect(engine.listActiveProducers('call-producer')).resolves.toEqual([
      {
        producerId: 'producer-2',
        userId: 'user-a',
        kind: 'video',
        paused: false,
      },
    ]);
  });

  it('keeps old request ids idempotent after replacing a producer', async () => {
    const { engine, transport } = await createConnectedEngine();
    const initialProducer = {
      id: 'producer-initial',
      on: jest.fn(),
      close: jest.fn(),
    };
    transport.produce.mockResolvedValueOnce(initialProducer);
    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-1',
        'video',
        {},
        'request-before-rebuild',
      ),
    ).resolves.toEqual({ producerId: 'producer-initial' });

    const replacementProducer = {
      id: 'producer-replacement',
      on: jest.fn(),
      close: jest.fn(),
    };
    const replacementTransport = {
      ...transport,
      id: 'transport-replacement',
      produce: jest.fn().mockResolvedValue(replacementProducer),
    };
    const room = (
      engine as unknown as { rooms: Map<string, unknown> }
    ).rooms.get('call-producer') as {
      router: { createWebRtcTransport: jest.Mock };
    };
    room.router.createWebRtcTransport.mockResolvedValueOnce(
      replacementTransport,
    );
    await engine.createSendTransport('call-producer', 'user-a');
    await engine.connectTransport(
      'call-producer',
      'user-a',
      'transport-replacement',
      {},
    );

    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-replacement',
        'video',
        {},
        'request-after-rebuild',
      ),
    ).resolves.toEqual({
      producerId: 'producer-replacement',
      replacedProducerId: 'producer-initial',
    });
    await expect(
      engine.produce(
        'call-producer',
        'user-a',
        'transport-replacement',
        'video',
        {},
        'request-before-rebuild',
      ),
    ).resolves.toEqual({ producerId: 'producer-replacement' });
    expect(replacementTransport.produce).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a producer that finishes after terminal room cleanup', async () => {
    const { engine, transport, producer } = await createConnectedEngine();
    let resolveProduce: (value: typeof producer) => void = () => undefined;
    transport.produce.mockImplementationOnce(
      () => new Promise((resolve) => (resolveProduce = resolve)),
    );

    const creation = engine.produce(
      'call-producer',
      'user-a',
      'transport-1',
      'video',
      {},
      'request-terminal-race',
    );
    const cleanup = engine.closeRoom('call-producer');
    await Promise.resolve();
    await expect(cleanup).resolves.toBeUndefined();
    expect(() => engine.listActiveProducers('call-producer')).toThrow(
      'Call room not found',
    );

    resolveProduce(producer);
    await expect(creation).rejects.toThrow('Call room not found');
    expect(producer.close).toHaveBeenCalledTimes(1);
  });
});

describe('MediasoupCallMediaEngine consumer lifecycle', () => {
  const createConsumerEngine = async () => {
    const consumers = [
      {
        id: 'consumer-1',
        rtpParameters: { codecs: [] },
        on: jest.fn(),
        close: jest.fn(),
        resume: jest.fn().mockResolvedValue(undefined),
      },
      {
        id: 'consumer-2',
        rtpParameters: { codecs: [] },
        on: jest.fn(),
        close: jest.fn(),
        resume: jest.fn().mockResolvedValue(undefined),
      },
    ];
    const recvTransport = {
      id: 'recv-1',
      consume: jest
        .fn()
        .mockResolvedValueOnce(consumers[0])
        .mockResolvedValueOnce(consumers[1]),
    };
    const producer = { id: 'producer-1', kind: 'audio' as const };
    const router = {
      id: 'router-consumer',
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: jest.fn(),
      canConsume: jest.fn().mockReturnValue(true),
    };
    const { engine } = createEngine(jest.fn().mockResolvedValue(router));
    await engine.createRoom('call-consumer');

    const room = (
      engine as unknown as {
        rooms: Map<
          string,
          {
            transports: Map<string, unknown>;
            transportMeta: Map<string, unknown>;
            producers: Map<string, unknown>;
            producerMeta: Map<string, unknown>;
            consumers: Map<string, unknown>;
          }
        >;
      }
    ).rooms.get('call-consumer');
    if (!room) throw new Error('test room missing');

    room.transports.set(recvTransport.id, recvTransport);
    room.transportMeta.set(recvTransport.id, {
      callId: 'call-consumer',
      userId: 'user-b',
      direction: 'recv',
      connected: true,
    });
    room.producers.set(producer.id, producer);
    room.producerMeta.set(producer.id, {
      callId: 'call-consumer',
      userId: 'user-a',
      transportId: 'send-1',
      kind: 'audio',
    });

    return { engine, recvTransport, consumers, room };
  };

  it('replaces a stale receiver consumer after the replacement was allocated', async () => {
    const { engine, recvTransport, consumers, room } =
      await createConsumerEngine();

    await expect(
      engine.consume('call-consumer', 'user-b', 'recv-1', 'producer-1', {}),
    ).resolves.toEqual(expect.objectContaining({ consumerId: 'consumer-1' }));
    await expect(
      engine.consume('call-consumer', 'user-b', 'recv-1', 'producer-1', {}),
    ).resolves.toEqual(expect.objectContaining({ consumerId: 'consumer-2' }));

    expect(recvTransport.consume).toHaveBeenCalledTimes(2);
    expect(consumers[0].close).toHaveBeenCalledTimes(1);
    expect(room.consumers.size).toBe(1);
    expect(room.consumers.has('consumer-1')).toBe(false);
    expect(room.consumers.has('consumer-2')).toBe(true);
  });

  it('does not tear down the working consumer when replacement allocation fails', async () => {
    const { engine, recvTransport, consumers, room } =
      await createConsumerEngine();

    await engine.consume(
      'call-consumer',
      'user-b',
      'recv-1',
      'producer-1',
      {},
    );
    recvTransport.consume.mockRejectedValueOnce(new Error('allocation failed'));

    await expect(
      engine.consume('call-consumer', 'user-b', 'recv-1', 'producer-1', {}),
    ).rejects.toThrow('allocation failed');

    expect(consumers[0].close).not.toHaveBeenCalled();
    expect(room.consumers.has('consumer-1')).toBe(true);
  });

  it('closes explicit consumer cleanup idempotently and enforces ownership', async () => {
    const { engine, consumers, room } = await createConsumerEngine();

    await engine.consume(
      'call-consumer',
      'user-b',
      'recv-1',
      'producer-1',
      {},
    );

    await expect(
      engine.closeConsumer('call-consumer', 'user-a', 'consumer-1'),
    ).rejects.toThrow('Consumer not found');
    await expect(
      engine.closeConsumer('call-consumer', 'user-b', 'consumer-1'),
    ).resolves.toEqual({ closed: true });
    await expect(
      engine.closeConsumer('call-consumer', 'user-b', 'consumer-1'),
    ).resolves.toEqual({ closed: false });

    expect(consumers[0].close).toHaveBeenCalledTimes(1);
    expect(room.consumers.size).toBe(0);
  });
});

describe('MediasoupCallMediaEngine fixed-port WebRtcServer', () => {
  it('uses the worker WebRtcServer instead of allocating a per-transport port', async () => {
    const transport = {
      id: 'transport-fixed-port',
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {},
      close: jest.fn(),
      on: jest.fn(),
      observer: { on: jest.fn() },
    };
    const router = {
      id: 'router-fixed-port',
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: jest.fn(),
      createWebRtcTransport: jest.fn().mockResolvedValue(transport),
    };
    const { engine, worker } = createEngine(
      jest.fn().mockResolvedValue(router),
    );
    const webRtcServer = { id: 'shared-udp-socket' };
    (
      engine as unknown as {
        webRtcServers: Map<unknown, unknown>;
      }
    ).webRtcServers.set(worker, webRtcServer);

    await engine.createRoom('call-fixed-port');
    await engine.createSendTransport('call-fixed-port', 'user-a');

    expect(router.createWebRtcTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        webRtcServer,
        enableUdp: true,
        enableTcp: false,
      }),
    );
    expect(router.createWebRtcTransport.mock.calls[0][0]).not.toHaveProperty(
      'listenIps',
    );
  });
});
