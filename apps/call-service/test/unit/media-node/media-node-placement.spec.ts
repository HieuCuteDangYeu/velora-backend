import type { MediaNodeRecord } from '../../../src/media-node/media-node.contract';
import { MediaNodeIdentity } from '../../../src/media-node/media-node-identity';
import { selectMediaNode } from '../../../src/media-node/media-node-placement';

const node = (
  nodeId: string,
  rooms: number,
  extra: Partial<MediaNodeRecord> = {},
): MediaNodeRecord => ({
  nodeId,
  incarnation: `${nodeId}-run`,
  rpcHost: nodeId,
  rpcPort: 4100,
  rooms,
  updatedAtMs: 0,
  ...extra,
});

const first = () => 0;

describe('selectMediaNode', () => {
  it('returns nothing when no node is alive', () => {
    expect(selectMediaNode([])).toBeUndefined();
  });

  it('keeps the former behaviour for nodes without priority: fewest rooms', () => {
    expect(
      selectMediaNode([node('busy', 5), node('idle', 1)], first)?.nodeId,
    ).toBe('idle');
  });

  it('picks randomly among equally loaded nodes of the same priority', () => {
    const nodes = [node('a', 2), node('b', 2)];
    expect(selectMediaNode(nodes, () => 0)?.nodeId).toBe('a');
    expect(selectMediaNode(nodes, () => 0.99)?.nodeId).toBe('b');
  });

  it('prefers the more preferred node even when the remote one is emptier', () => {
    const nodes = [
      node('home', 7, { priority: 0, maxRooms: 20 }),
      node('remote', 0, { priority: 1 }),
    ];
    expect(selectMediaNode(nodes, first)?.nodeId).toBe('home');
  });

  it('spills over to the next priority once the preferred node is full', () => {
    const nodes = [
      node('home', 20, { priority: 0, maxRooms: 20 }),
      node('remote', 3, { priority: 1 }),
    ];
    expect(selectMediaNode(nodes, first)?.nodeId).toBe('remote');
  });

  it('uses the remote node as failover when the preferred node is gone', () => {
    expect(
      selectMediaNode([node('remote', 12, { priority: 1 })], first)?.nodeId,
    ).toBe('remote');
  });

  it('never refuses a call: when every node is full it picks the least loaded', () => {
    const nodes = [
      node('home', 25, { priority: 0, maxRooms: 20 }),
      node('remote', 9, { priority: 1, maxRooms: 5 }),
    ];
    expect(selectMediaNode(nodes, first)?.nodeId).toBe('remote');
  });

  it('treats a maxRooms of 0 or a missing value as no limit', () => {
    const nodes = [
      node('home', 500, { priority: 0, maxRooms: 0 }),
      node('remote', 0, { priority: 1 }),
    ];
    expect(selectMediaNode(nodes, first)?.nodeId).toBe('home');
  });

  it('ignores invalid priorities instead of trusting them', () => {
    const nodes = [
      node('odd', 1, { priority: Number.NaN }),
      node('negative', 0, { priority: -3 }),
    ];
    // Both count as priority 0, so the fewest rooms wins.
    expect(selectMediaNode(nodes, first)?.nodeId).toBe('negative');
  });

  it('spills over in priority order across three tiers', () => {
    const nodes = [
      node('a', 4, { priority: 0, maxRooms: 4 }),
      node('b', 2, { priority: 1, maxRooms: 2 }),
      node('c', 0, { priority: 2 }),
    ];
    expect(selectMediaNode(nodes, first)?.nodeId).toBe('c');
  });
});

describe('MediaNodeIdentity placement settings', () => {
  const keys = ['CALL_MEDIA_NODE_PRIORITY', 'CALL_MEDIA_NODE_MAX_ROOMS'];
  afterEach(() => {
    for (const key of keys) delete process.env[key];
  });

  it('defaults to priority 0 and no room limit', () => {
    const identity = new MediaNodeIdentity();
    expect(identity.priority).toBe(0);
    expect(identity.maxRooms).toBe(0);
  });

  it('reads the priority and room limit from the environment', () => {
    process.env.CALL_MEDIA_NODE_PRIORITY = '1';
    process.env.CALL_MEDIA_NODE_MAX_ROOMS = '20';
    const identity = new MediaNodeIdentity();
    expect(identity.priority).toBe(1);
    expect(identity.maxRooms).toBe(20);
  });

  it('falls back to the defaults for values that are not whole numbers', () => {
    process.env.CALL_MEDIA_NODE_PRIORITY = '-1';
    process.env.CALL_MEDIA_NODE_MAX_ROOMS = 'many';
    const identity = new MediaNodeIdentity();
    expect(identity.priority).toBe(0);
    expect(identity.maxRooms).toBe(0);
  });
});
