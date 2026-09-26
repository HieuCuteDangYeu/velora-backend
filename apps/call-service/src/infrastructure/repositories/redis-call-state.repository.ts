import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { CallParticipant } from '../../domain/entities/call-participant.entity';
import { ICallStateRepository } from '../../domain/interfaces/call-state.repository.interface';

export interface StoredRoomState {
  callId: string;
  routerId: string;
  workerId: string;
}

export interface StoredTransportState {
  transportId: string;
  callId: string;
  userId: string;
  direction: 'send' | 'recv';
  connected: boolean;
}

export interface StoredProducerState {
  producerId: string;
  transportId: string;
  callId: string;
  userId: string;
  kind: 'audio' | 'video';
}

@Injectable()
export class RedisCallStateRepository implements ICallStateRepository {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async upsertParticipant(participant: CallParticipant): Promise<void> {
    const existing = await this.getParticipant(
      participant.callId,
      participant.userId,
    );
    const nextParticipant = new CallParticipant({
      ...existing,
      ...participant,
      socketIds: participant.socketIds,
      isConnected:
        participant.isConnected ??
        existing?.isConnected ??
        participant.socketIds.length > 0,
    });
    const key = this.participantKey(participant.callId);
    await this.redis.hset(
      key,
      participant.userId,
      JSON.stringify(nextParticipant),
    );
    await this.redis.expire(key, 60 * 60 * 6);
  }

  async removeParticipant(callId: string, userId: string): Promise<void> {
    await this.redis.hdel(this.participantKey(callId), userId);
  }

  async removeParticipantSocket(
    callId: string,
    userId: string,
    socketId: string,
  ): Promise<CallParticipant | null> {
    const participant = await this.getParticipant(callId, userId);
    if (!participant) {
      return null;
    }

    const remainingSocketIds = participant.socketIds.filter(
      (storedSocketId) => storedSocketId !== socketId,
    );
    const nextParticipant = new CallParticipant({
      ...participant,
      socketId: remainingSocketIds[0],
      socketIds: remainingSocketIds,
      isConnected: remainingSocketIds.length > 0,
    });

    if (remainingSocketIds.length === 0) {
      await this.redis.hdel(this.participantKey(callId), userId);
      return nextParticipant;
    }

    const key = this.participantKey(callId);
    await this.redis.hset(key, userId, JSON.stringify(nextParticipant));
    await this.redis.expire(key, 60 * 60 * 6);
    return nextParticipant;
  }

  async getParticipants(callId: string): Promise<CallParticipant[]> {
    const entries = await this.redis.hgetall(this.participantKey(callId));
    return Object.values(entries).map(
      (value) =>
        new CallParticipant(JSON.parse(value) as Partial<CallParticipant>),
    );
  }

  async getParticipant(
    callId: string,
    userId: string,
  ): Promise<CallParticipant | null> {
    const raw = await this.redis.hget(this.participantKey(callId), userId);
    if (!raw) {
      return null;
    }

    return new CallParticipant(JSON.parse(raw) as Partial<CallParticipant>);
  }

  async clearCallState(callId: string): Promise<void> {
    await this.redis.eval(
      `local keys = {KEYS[1], KEYS[2], KEYS[3], KEYS[4]}
       for _, mediaIndex in ipairs({
         {KEYS[3], 'call:' .. ARGV[1] .. ':transport:'},
         {KEYS[4], 'call:' .. ARGV[1] .. ':producer:'}
       }) do
         local indexKey = mediaIndex[1]
         local indexType = redis.call('TYPE', indexKey).ok
         if indexType ~= 'none' and indexType ~= 'set' then
           return redis.error_reply('Invalid call state index type')
         end
         for _, mediaKey in ipairs(redis.call('SMEMBERS', indexKey)) do
           if string.sub(mediaKey, 1, #mediaIndex[2]) == mediaIndex[2] then
             table.insert(keys, mediaKey)
           end
         end
       end
       return redis.call('DEL', unpack(keys))`,
      4,
      this.roomKey(callId),
      this.participantKey(callId),
      this.transportIndexKey(callId),
      this.producerIndexKey(callId),
      callId,
    );
  }

  async getTransport(
    callId: string,
    userId: string,
    direction: string,
  ): Promise<StoredTransportState | null> {
    const raw = await this.redis.get(
      this.transportKey(callId, userId, direction),
    );
    if (!raw) return null;
    return JSON.parse(raw) as StoredTransportState;
  }

  async saveRoom(room: StoredRoomState): Promise<void> {
    await this.redis.set(
      this.roomKey(room.callId),
      JSON.stringify(room),
      'EX',
      60 * 60 * 6,
    );
  }

  async removeRoomIfRouterId(callId: string, routerId: string): Promise<void> {
    await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw or cjson.decode(raw).routerId ~= ARGV[1] then return 0 end
       return redis.call('DEL', KEYS[1])`,
      1,
      this.roomKey(callId),
      routerId,
    );
  }

  async getRoom(callId: string): Promise<StoredRoomState | null> {
    const raw = await this.redis.get(this.roomKey(callId));
    if (!raw) return null;
    return JSON.parse(raw) as StoredRoomState;
  }

  async saveTransportState(state: StoredTransportState): Promise<void> {
    const key = this.transportKey(state.callId, state.userId, state.direction);
    await this.saveIndexedState(
      key,
      this.transportIndexKey(state.callId),
      state,
    );
  }

  async removeTransportState(
    callId: string,
    userId: string,
    direction: 'send' | 'recv',
    transportId: string,
  ): Promise<void> {
    const key = this.transportKey(callId, userId, direction);
    await this.redis.eval(
      `local indexType = redis.call('TYPE', KEYS[2]).ok
       if indexType ~= 'none' and indexType ~= 'set' then
         return redis.error_reply('Invalid call state index type')
       end
       local raw = redis.call('GET', KEYS[1])
       if raw and cjson.decode(raw).transportId ~= ARGV[1] then return 0 end
       redis.call('DEL', KEYS[1])
       redis.call('SREM', KEYS[2], KEYS[1])
       return 1`,
      2,
      key,
      this.transportIndexKey(callId),
      transportId,
    );
  }

  async saveProducerState(state: StoredProducerState): Promise<void> {
    const key = this.producerKey(state.callId, state.userId, state.producerId);
    await this.saveIndexedState(
      key,
      this.producerIndexKey(state.callId),
      state,
    );
  }

  async removeProducerState(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    const key = this.producerKey(callId, userId, producerId);
    await this.redis.eval(
      `local indexType = redis.call('TYPE', KEYS[2]).ok
       if indexType ~= 'none' and indexType ~= 'set' then
         return redis.error_reply('Invalid call state index type')
       end
       redis.call('DEL', KEYS[1])
       redis.call('SREM', KEYS[2], KEYS[1])
       return 1`,
      2,
      key,
      this.producerIndexKey(callId),
    );
  }

  private async saveIndexedState(
    key: string,
    indexKey: string,
    state: StoredTransportState | StoredProducerState,
  ): Promise<void> {
    await this.redis.eval(
      `local indexType = redis.call('TYPE', KEYS[2]).ok
       if indexType ~= 'none' and indexType ~= 'set' then
         return redis.error_reply('Invalid call state index type')
       end
       local rawSession = redis.call('GET', KEYS[3])
       if not rawSession then return redis.error_reply('Call media admission denied') end
       local session = cjson.decode(rawSession)
       if session.status ~= 'active' then
         return redis.error_reply('Call media admission denied')
       end
       local joined = false
       for _, participantId in ipairs(session.participantIds or {}) do
         if participantId == ARGV[3] then joined = true break end
       end
       if not joined then return redis.error_reply('Call media admission denied') end
       redis.call('SADD', KEYS[2], KEYS[1])
       redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
       redis.call('EXPIRE', KEYS[2], ARGV[2])
       return 1`,
      3,
      key,
      indexKey,
      this.sessionKey(state.callId),
      JSON.stringify(state),
      60 * 60 * 6,
      state.userId,
    );
  }

  private roomKey(callId: string): string {
    return `call:${callId}:room`;
  }

  private sessionKey(callId: string): string {
    return `call:${callId}:session`;
  }

  private participantKey(callId: string): string {
    return `call:${callId}:participants`;
  }

  private transportKey(
    callId: string,
    userId: string,
    direction: string,
  ): string {
    return `call:${callId}:transport:${userId}:${direction}`;
  }

  private producerKey(
    callId: string,
    userId: string,
    producerId: string,
  ): string {
    return `call:${callId}:producer:${userId}:${producerId}`;
  }

  private transportIndexKey(callId: string): string {
    return `call:${callId}:transport-index`;
  }

  private producerIndexKey(callId: string): string {
    return `call:${callId}:producer-index`;
  }
}
