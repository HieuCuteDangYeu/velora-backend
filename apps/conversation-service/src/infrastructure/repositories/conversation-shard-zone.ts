import { createHash } from 'crypto';

/**
 * Which half of the sharded cluster holds a conversation.
 *
 * conversation_db is sharded on hashed keys (conversations `_id`, members and
 * messages `conversationId`), and the zones split the hashed space at 0:
 * `lab2` (shard rs1, the Windows laptop) owns [MinKey, 0) and `home` (shard rs0,
 * the homelab) owns [0, MaxKey). See infra/mongo-shard/README.md.
 *
 * mongoHashedObjectId reproduces MongoDB's hashed-index value for an ObjectId
 * (BSONElementHasher::hash64 with seed 0): md5 over the seed (int32 LE), the
 * canonical BSON type of ObjectId (35, int32 LE) and the 12 id bytes; the
 * result is the first 8 digest bytes as a signed little-endian int64. The spec
 * checks it against values computed by MongoDB 8.0 (convertShardKeyToHashed).
 */

export const ZONE_BELOW_ZERO = 'lab2';
export const ZONE_FROM_ZERO = 'home';

const OBJECT_ID_CANONICAL_TYPE = 35;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export function mongoHashedObjectId(id: string): bigint | null {
  if (!OBJECT_ID_PATTERN.test(id)) return null;
  const input = Buffer.alloc(20);
  input.writeInt32LE(0, 0);
  input.writeInt32LE(OBJECT_ID_CANONICAL_TYPE, 4);
  Buffer.from(id, 'hex').copy(input, 8);
  return createHash('md5').update(input).digest().readBigInt64LE(0);
}

/** The zone of a conversation, or null when the id is not an ObjectId. */
export function shardZoneOf(conversationId: string): string | null {
  const hashed = mongoHashedObjectId(conversationId);
  if (hashed === null) return null;
  return hashed < 0n ? ZONE_BELOW_ZERO : ZONE_FROM_ZERO;
}
