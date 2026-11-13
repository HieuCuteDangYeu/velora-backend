import type Redis from 'ioredis';
import { RemoteCallMediaEngine } from '../../../src/infrastructure/engines/remote-call-media.engine';
import {
  callMediaPlacementKey,
  MEDIA_NODES_KEY,
  mediaNodeCallsKey,
  mediaNodeKey,
  type MediaNodeRecord,
} from '../../../src/media-node/media-node.contract';
import {
  redisServerAvailable,
  startTemporaryRedis,
  type TemporaryRedis,
} from '../../support/temporary-redis';

(redisServerAvailable ? describe : describe.skip)(
  'RemoteCallMediaEngine placement (real Redis)',
  () => {
    let temporary: TemporaryRedis;
    let redis: Redis;
    const clearCallState = jest.fn().mockResolvedValue(undefined);

    const registerNode = async (record: Partial<MediaNodeRecord> = {}) => {
      const node: MediaNodeRecord = {
        nodeId: 'node-a',
        incarnation: 'run-1',
        rpcHost: '127.0.0.1',
        rpcPort: 1,
        rooms: 0,
        updatedAtMs: Date.now(),
        ...record,
      };
      await redis.set(mediaNodeKey(node.nodeId), JSON.stringify(node));
      await redis.zadd(MEDIA_NODES_KEY, node.updatedAtMs, node.nodeId);
      return node;
    };

    const engine = () => {
      const instance = new RemoteCallMediaEngine(redis, {
        clearCallState,
      } as never);
      // Stand in for the TCP hop; placement logic is what is under test.
      const invokeOn = jest.fn().mockResolvedValue(undefined);
      (instance as unknown as { invokeOn: jest.Mock }).invokeOn = invokeOn;
      return { instance, invokeOn };
    };

    beforeAll(async () => {
      temporary = await startTemporaryRedis();
      redis = await temporary.client();
    });
    beforeEach(async () => {
      await redis.flushall();
      clearCallState.mockClear();
    });
    afterAll(() => temporary?.stop());

    it('places concurrent createRoom calls from two replicas on one node', async () => {
      await registerNode({ nodeId: 'node-a' });
      await registerNode({ nodeId: 'node-b', incarnation: 'run-9' });
      const a = engine();
      const b = engine();

      await Promise.all([
        a.instance.createRoom('call-1'),
        b.instance.createRoom('call-1'),
      ]);

      const placements = [
        ...a.invokeOn.mock.calls,
        ...b.invokeOn.mock.calls,
      ].map(([placement]) => (placement as { nodeId: string }).nodeId);
      expect(new Set(placements).size).toBe(1);
      expect(await redis.smembers(mediaNodeCallsKey(placements[0]))).toEqual([
        'call-1',
      ]);
    });

    it('prefers the node with the fewest rooms', async () => {
      await registerNode({ nodeId: 'busy', rooms: 5 });
      await registerNode({ nodeId: 'idle', rooms: 1 });
      const { instance } = engine();
      await instance.createRoom('call-2');
      expect(
        JSON.parse((await redis.get(callMediaPlacementKey('call-2')))!),
      ).toMatchObject({ nodeId: 'idle' });
    });

    it('keeps new calls on the preferred node until it is full, then overflows', async () => {
      await registerNode({
        nodeId: 'home',
        priority: 0,
        maxRooms: 2,
        rooms: 1,
      });
      await registerNode({ nodeId: 'remote', priority: 1, rooms: 0 });
      const { instance } = engine();
      await instance.createRoom('call-a');
      expect(
        JSON.parse((await redis.get(callMediaPlacementKey('call-a')))!),
      ).toMatchObject({ nodeId: 'home' });

      await registerNode({
        nodeId: 'home',
        priority: 0,
        maxRooms: 2,
        rooms: 2,
      });
      await instance.createRoom('call-b');
      expect(
        JSON.parse((await redis.get(callMediaPlacementKey('call-b')))!),
      ).toMatchObject({ nodeId: 'remote' });
    });

    it('fails clearly when no media node is alive', async () => {
      const { instance } = engine();
      await expect(instance.createRoom('call-3')).rejects.toThrow(
        'Media worker is unavailable',
      );
    });

    it('closes a room whose node is gone without calling it, and clears state', async () => {
      await registerNode({ nodeId: 'node-a', incarnation: 'run-1' });
      const real = new RemoteCallMediaEngine(redis, {
        clearCallState,
      } as never);
      await (
        real as unknown as {
          place(callId: string): Promise<unknown>;
        }
      ).place('call-4');
      await redis.del(mediaNodeKey('node-a'));

      await expect(real.closeRoom('call-4')).resolves.toBeUndefined();
      expect(await redis.get(callMediaPlacementKey('call-4'))).toBeNull();
      expect(clearCallState).toHaveBeenCalledWith('call-4');
      await expect(real.closeParticipant('call-4', 'user-1')).resolves.toEqual({
        producers: [],
      });
    });

    it('reports calls of a restarted node as lost, once, from one replica', async () => {
      await registerNode({ nodeId: 'node-a', incarnation: 'run-1' });
      const a = engine();
      await a.instance.createRoom('call-5');
      await registerNode({ nodeId: 'node-a', incarnation: 'run-2' });

      const lostA = jest.fn();
      const lostB = jest.fn();
      const b = engine();
      a.instance.onRoomsLost(lostA);
      b.instance.onRoomsLost(lostB);
      await Promise.all([
        a.instance.sweepLostNodes(),
        b.instance.sweepLostNodes(),
      ]);

      expect([...lostA.mock.calls, ...lostB.mock.calls]).toEqual([
        [['call-5']],
      ]);
    });

    it('ignores a rooms-lost event from an older incarnation', async () => {
      await registerNode({ nodeId: 'node-a', incarnation: 'run-2' });
      const { instance } = engine();
      await instance.createRoom('call-6');
      const lost = jest.fn();
      instance.onRoomsLost(lost);

      await instance.handleRoomsLostEvent({
        nodeId: 'node-a',
        incarnation: 'run-1',
        callIds: ['call-6'],
      });
      expect(lost).not.toHaveBeenCalled();

      await instance.handleRoomsLostEvent({
        nodeId: 'node-a',
        incarnation: 'run-2',
        callIds: ['call-6'],
      });
      expect(lost).toHaveBeenCalledWith(['call-6']);
    });
  },
);
