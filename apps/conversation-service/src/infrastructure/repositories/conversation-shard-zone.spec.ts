import {
  mongoHashedObjectId,
  shardZoneOf,
  ZONE_BELOW_ZERO,
  ZONE_FROM_ZERO,
} from './conversation-shard-zone';

// Computed by MongoDB 8.0.34 with convertShardKeyToHashed(ObjectId(id)).
const MONGO_VALUES: Record<string, string> = {
  '000000000000000000000000': '-4293118519463489418',
  '6af775b09b6c568d77df583b': '-3363503321124958237',
  '69b825f216ee000000000001': '-2446163832771359746',
  ffffffffffffffffffffffff: '5619280371875468158',
  '5f1e2d3c4b5a69788796a5b4': '-1874533823204590463',
  '6923a1b2c3d4e5f601234567': '5574945612597405530',
};

describe('conversation shard zone', () => {
  it.each(Object.entries(MONGO_VALUES))(
    'hashes %s exactly like MongoDB',
    (id, expected) => {
      expect(mongoHashedObjectId(id)?.toString()).toBe(expected);
      expect(mongoHashedObjectId(id.toUpperCase())?.toString()).toBe(expected);
    },
  );

  it('puts negative hashes in the laptop zone and the rest in the homelab zone', () => {
    expect(shardZoneOf('6af775b09b6c568d77df583b')).toBe(ZONE_BELOW_ZERO);
    expect(shardZoneOf('6923a1b2c3d4e5f601234567')).toBe(ZONE_FROM_ZERO);
  });

  it('has no zone for ids that are not ObjectIds', () => {
    expect(mongoHashedObjectId('not-an-object-id')).toBeNull();
    expect(shardZoneOf('')).toBeNull();
  });
});
