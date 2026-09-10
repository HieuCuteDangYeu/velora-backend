import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { CallSession } from '../../domain/entities/call-session.entity';
import {
  type CallActivationTransition,
  type CallAnswerOutboxEvent,
  type CallAnswerTransition,
  type CallExpiryTransition,
  type CallJoinTransition,
  type CallTerminalOutboxEvent,
  type CallTerminalTransition,
  ICallSessionRepository,
} from '../../domain/interfaces/call-session.repository.interface';

const SESSION_TTL_SECONDS = 60 * 60 * 6;
const ANSWER_ACCEPT_LEASE_MS = 10_000;
const ANSWER_EVENT_PUBLICATION_LEASE_MS = 10_000;
const TERMINAL_EVENT_PUBLICATION_LEASE_MS = 10_000;
const EXPIRING_CALLS_KEY = 'call:sessions:expiring';
const ANSWER_EVENT_OUTBOX_KEY = 'call:sessions:answer-events';
const TERMINAL_EVENT_OUTBOX_KEY = 'call:sessions:terminal-events';
const ACTIVE_CALLS_KEY = 'call:sessions:active';
const ACTIVE_CALLS_BY_USER_KEY = 'call:sessions:active-by-user';

const JOIN_PARTICIPANT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'not_found'} end

local session = cjson.decode(raw)
local now = ARGV[1]
local userId = ARGV[2]
if session.expiresAt and session.expiresAt <= now and (session.status == 'initiated' or session.status == 'ringing') then
  session.status = 'ended'
  session.terminalReason = 'no_answer'
  session.terminalActorId = session.initiatorId
  session.terminalEventPublishedAt = cjson.null
  session.terminalEventPublishLeaseUntil = cjson.null
  session.endedAt = now
  session.updatedAt = now
  session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
  local encoded = cjson.encode(session)
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
  redis.call('ZREM', KEYS[2], session.callId)
  redis.call('ZREM', KEYS[3], session.callId)
  redis.call('ZREM', KEYS[4], session.callId)
  redis.call('ZADD', KEYS[6], ARGV[3], session.callId)
  if redis.call('HGET', KEYS[5], session.initiatorId) == session.callId then
    redis.call('HDEL', KEYS[5], session.initiatorId)
  end
  if redis.call('HGET', KEYS[5], session.targetUserId) == session.callId then
    redis.call('HDEL', KEYS[5], session.targetUserId)
  end
  return {'expired', encoded, '0'}
end
if userId ~= session.initiatorId and userId ~= session.targetUserId then
  return {'forbidden', raw, '0'}
end
if session.status == 'ended' or session.status == 'cancelled' or session.status == 'rejected' then
  return {'terminal', raw, '0'}
end

local joinedNow = true
for _, participantId in ipairs(session.participantIds or {}) do
  if participantId == userId then
    joinedNow = false
    break
  end
end
if joinedNow then
  table.insert(session.participantIds, userId)
end
if userId == session.targetUserId and session.status == 'initiated' then
  session.status = 'ringing'
end
session.updatedAt = now
session.lifecycleRevision = (session.lifecycleRevision or 0) + 1

local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
local encoded = cjson.encode(session)
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
return {'joined', encoded, joinedNow and '1' or '0'}
`;

const CLAIM_INCOMING_ANSWER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'not_found'} end

local session = cjson.decode(raw)
local now = ARGV[1]
local userId = ARGV[2]
local actionId = ARGV[3]
local acceptingLeaseUntil = ARGV[4]
local acceptingLeaseUntilMs = ARGV[5]
if userId ~= session.targetUserId then
  return {'forbidden', raw, '0'}
end
if session.expiresAt and session.expiresAt <= now and (session.status == 'initiated' or session.status == 'ringing') then
  session.status = 'ended'
  session.terminalReason = 'no_answer'
  session.terminalActorId = session.initiatorId
  session.terminalEventPublishedAt = cjson.null
  session.terminalEventPublishLeaseUntil = cjson.null
  session.endedAt = now
  session.updatedAt = now
  session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
  local encoded = cjson.encode(session)
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
  redis.call('ZREM', KEYS[2], session.callId)
  redis.call('ZREM', KEYS[3], session.callId)
  redis.call('ZREM', KEYS[4], session.callId)
  redis.call('ZADD', KEYS[6], ARGV[6], session.callId)
  if redis.call('HGET', KEYS[5], session.initiatorId) == session.callId then
    redis.call('HDEL', KEYS[5], session.initiatorId)
  end
  if redis.call('HGET', KEYS[5], session.targetUserId) == session.callId then
    redis.call('HDEL', KEYS[5], session.targetUserId)
  end
  return {'expired', encoded, '0'}
end
if session.status == 'accepting' or session.status == 'active' then
  if session.answerActionId == actionId then
    return {'already_accepted', raw, '0'}
  end
  return {'answered_elsewhere', raw, '0'}
end
if session.status == 'ended' or session.status == 'cancelled' or session.status == 'rejected' then
  return {'terminal', raw, '0'}
end
local targetActiveCallId = redis.call('HGET', KEYS[5], session.targetUserId)
local initiatorActiveCallId = redis.call('HGET', KEYS[5], session.initiatorId)
if (targetActiveCallId and targetActiveCallId ~= session.callId) or
   (initiatorActiveCallId and initiatorActiveCallId ~= session.callId) then
  return {'busy', raw, '0'}
end

local isParticipant = false
for _, participantId in ipairs(session.participantIds or {}) do
  if participantId == userId then
    isParticipant = true
    break
  end
end
if not isParticipant then
  table.insert(session.participantIds, userId)
end
session.status = 'accepting'
session.answerActionId = actionId
session.answerLeaseExpiresAt = acceptingLeaseUntil
session.answeredAt = now
session.updatedAt = now
session.lifecycleRevision = (session.lifecycleRevision or 0) + 1

local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
local encoded = cjson.encode(session)
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
redis.call('ZADD', KEYS[2], acceptingLeaseUntilMs, session.callId)
return {'accepted', encoded, '0'}
`;

const ACTIVATE_INCOMING_ANSWER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'not_found'} end

local session = cjson.decode(raw)
local now = ARGV[1]
local nowMs = ARGV[2]
local userId = ARGV[3]
local actionId = ARGV[4]
if userId ~= session.targetUserId then
  return {'forbidden', raw}
end
if session.status == 'active' then
  if session.answerActionId == actionId then
    return {'already_accepted', raw}
  end
  return {'answered_elsewhere', raw}
end
if session.status == 'ended' or session.status == 'cancelled' or session.status == 'rejected' then
  return {'terminal', raw}
end
if session.status ~= 'accepting' or session.answerActionId ~= actionId then
  return {'answered_elsewhere', raw}
end
local targetActiveCallId = redis.call('HGET', KEYS[5], session.targetUserId)
local initiatorActiveCallId = redis.call('HGET', KEYS[5], session.initiatorId)
if (targetActiveCallId and targetActiveCallId ~= session.callId) or
   (initiatorActiveCallId and initiatorActiveCallId ~= session.callId) then
  return {'busy', raw}
end
if session.answerLeaseExpiresAt and session.answerLeaseExpiresAt <= now then
  session.status = 'ended'
  session.terminalReason = 'media_unavailable'
  session.terminalActorId = userId
  session.terminalEventPublishedAt = cjson.null
  session.terminalEventPublishLeaseUntil = cjson.null
  session.endedAt = now
  session.updatedAt = now
  session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
  local encoded = cjson.encode(session)
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
  redis.call('ZREM', KEYS[2], session.callId)
  redis.call('ZREM', KEYS[3], session.callId)
  redis.call('ZREM', KEYS[4], session.callId)
  redis.call('ZADD', KEYS[6], nowMs, session.callId)
  if redis.call('HGET', KEYS[5], session.initiatorId) == session.callId then
    redis.call('HDEL', KEYS[5], session.initiatorId)
  end
  if redis.call('HGET', KEYS[5], session.targetUserId) == session.callId then
    redis.call('HDEL', KEYS[5], session.targetUserId)
  end
  return {'terminal', encoded}
end

session.status = 'active'
session.answerLeaseExpiresAt = cjson.null
session.answerEventPublishedAt = cjson.null
session.answerEventPublishLeaseUntil = cjson.null
session.updatedAt = now
session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
local encoded = cjson.encode(session)
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
redis.call('ZREM', KEYS[2], session.callId)
redis.call('ZADD', KEYS[3], nowMs, session.callId)
redis.call('ZADD', KEYS[4], nowMs, session.callId)
redis.call('HSET', KEYS[5], session.initiatorId, session.callId)
redis.call('HSET', KEYS[5], session.targetUserId, session.callId)
return {'accepted', encoded}
`;

const CLAIM_PENDING_ANSWER_EVENTS_SCRIPT = `
local nowMs = ARGV[1]
local now = ARGV[2]
local leaseUntilMs = ARGV[3]
local leaseUntil = ARGV[4]
local limit = tonumber(ARGV[5])
local keyPrefix = ARGV[6]
local keySuffix = ARGV[7]
local callIds = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', nowMs, 'LIMIT', 0, limit)
local results = {}

for _, callId in ipairs(callIds) do
  local callKey = keyPrefix .. callId .. keySuffix
  local raw = redis.call('GET', callKey)
  if not raw then
    redis.call('ZREM', KEYS[1], callId)
  else
    local session = cjson.decode(raw)
    local eventLeaseExpired = not session.answerEventPublishLeaseUntil or
      session.answerEventPublishLeaseUntil == cjson.null or
      session.answerEventPublishLeaseUntil <= now
    local answerEventIsPending = not session.answerEventPublishedAt or
      session.answerEventPublishedAt == cjson.null
    if session.status == 'active' and session.answerActionId and
       answerEventIsPending and eventLeaseExpired then
      session.answerEventPublishLeaseUntil = leaseUntil
      session.updatedAt = now
      local ttl = redis.call('TTL', callKey)
      if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
      local encoded = cjson.encode(session)
      redis.call('SET', callKey, encoded, 'EX', ttl)
      redis.call('ZADD', KEYS[1], leaseUntilMs, callId)
      table.insert(results, encoded)
    elseif session.status ~= 'active' or not answerEventIsPending then
      redis.call('ZREM', KEYS[1], callId)
    end
  end
end

return results
`;

const MARK_ANSWER_EVENT_PUBLISHED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end

local session = cjson.decode(raw)
if session.answerActionId ~= ARGV[1] or
   (session.answerEventPublishedAt and session.answerEventPublishedAt ~= cjson.null) then
  return 0
end
session.answerEventPublishedAt = ARGV[2]
session.answerEventPublishLeaseUntil = cjson.null
session.updatedAt = ARGV[2]
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ttl)
redis.call('ZREM', KEYS[2], session.callId)
return 1
`;

const CLAIM_PENDING_TERMINAL_EVENTS_SCRIPT = `
local nowMs = ARGV[1]
local now = ARGV[2]
local leaseUntilMs = ARGV[3]
local leaseUntil = ARGV[4]
local limit = tonumber(ARGV[5])
local keyPrefix = ARGV[6]
local keySuffix = ARGV[7]
local callIds = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', nowMs, 'LIMIT', 0, limit)
local results = {}

for _, callId in ipairs(callIds) do
  local callKey = keyPrefix .. callId .. keySuffix
  local raw = redis.call('GET', callKey)
  if not raw then
    redis.call('ZREM', KEYS[1], callId)
  else
    local session = cjson.decode(raw)
    local isTerminal = session.status == 'ended' or session.status == 'cancelled' or session.status == 'rejected'
    local eventLeaseExpired = not session.terminalEventPublishLeaseUntil or
      session.terminalEventPublishLeaseUntil == cjson.null or
      session.terminalEventPublishLeaseUntil <= now
    local eventIsPending = not session.terminalEventPublishedAt or
      session.terminalEventPublishedAt == cjson.null
    if isTerminal and eventIsPending and eventLeaseExpired then
      session.terminalEventPublishLeaseUntil = leaseUntil
      session.updatedAt = now
      local ttl = redis.call('TTL', callKey)
      if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
      local encoded = cjson.encode(session)
      redis.call('SET', callKey, encoded, 'EX', ttl)
      redis.call('ZADD', KEYS[1], leaseUntilMs, callId)
      table.insert(results, encoded)
    elseif not isTerminal or not eventIsPending then
      redis.call('ZREM', KEYS[1], callId)
    end
  end
end

return results
`;

const MARK_TERMINAL_EVENT_PUBLISHED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end

local session = cjson.decode(raw)
local isTerminal = session.status == 'ended' or session.status == 'cancelled' or session.status == 'rejected'
if not isTerminal or tostring(session.lifecycleRevision or 0) ~= ARGV[1] or
   (session.terminalEventPublishedAt and session.terminalEventPublishedAt ~= cjson.null) then
  return 0
end
session.terminalEventPublishedAt = ARGV[2]
session.terminalEventPublishLeaseUntil = cjson.null
session.updatedAt = ARGV[2]
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', ttl)
redis.call('ZREM', KEYS[2], session.callId)
return 1
`;

const TRANSITION_TO_TERMINAL_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'not_found'} end

local session = cjson.decode(raw)
local userId = ARGV[1]
local requestedReason = ARGV[2]
local now = ARGV[3]
local mode = ARGV[4]
local nowMs = ARGV[5]
local expectedAnswerActionId = ARGV[6]
local isTerminal = session.status == 'ended' or session.status == 'cancelled' or session.status == 'rejected'
local wasActive = session.status == 'active'

if mode == 'accept_failure' then
  if userId ~= session.targetUserId then
    return {'forbidden', raw, '', '0'}
  end
  if isTerminal then
    return {'already_terminal', raw, session.terminalReason or '', '0'}
  end
  if session.status == 'active' then
    if session.answerActionId == expectedAnswerActionId then
      return {'active', raw, '', '1'}
    end
    return {'stale', raw, '', '1'}
  end
  if session.status ~= 'accepting' or session.answerActionId ~= expectedAnswerActionId then
    return {'stale', raw, '', '0'}
  end
  session.status = 'ended'
  session.terminalReason = requestedReason ~= '' and requestedReason or 'media_unavailable'
elseif mode == 'reject' then
  if userId ~= session.targetUserId then
    return {'forbidden', raw, '', '0'}
  end
  if session.status == 'active' then
    return {'active', raw, '', '1'}
  end
  if isTerminal then
    return {'already_terminal', raw, session.terminalReason or '', '0'}
  end
  session.status = 'rejected'
  session.terminalReason = requestedReason ~= '' and requestedReason or 'rejected'
else
  local isParticipant = false
  for _, participantId in ipairs(session.participantIds or {}) do
    if participantId == userId then
      isParticipant = true
      break
    end
  end
  if not isParticipant then
    return {'forbidden', raw, '', '0'}
  end
  if isTerminal then
    return {'already_terminal', raw, session.terminalReason or '', '0'}
  end
  local reason = requestedReason
  if reason == '' then
    if session.status == 'active' then
      reason = 'ended'
    elseif userId == session.initiatorId then
      reason = 'cancelled'
    else
      reason = 'ended'
    end
  end
  session.status = reason == 'cancelled' and 'cancelled' or 'ended'
  session.terminalReason = reason
end

session.endedAt = now
session.updatedAt = now
session.terminalActorId = userId
session.terminalEventPublishedAt = cjson.null
session.terminalEventPublishLeaseUntil = cjson.null
session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
local encoded = cjson.encode(session)
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
redis.call('ZREM', KEYS[2], session.callId)
redis.call('ZREM', KEYS[3], session.callId)
redis.call('ZREM', KEYS[4], session.callId)
redis.call('ZADD', KEYS[6], nowMs, session.callId)
if redis.call('HGET', KEYS[5], session.initiatorId) == session.callId then
  redis.call('HDEL', KEYS[5], session.initiatorId)
end
if redis.call('HGET', KEYS[5], session.targetUserId) == session.callId then
  redis.call('HDEL', KEYS[5], session.targetUserId)
end
return {'transitioned', encoded, session.terminalReason or '', wasActive and '1' or '0'}
`;

const EXPIRE_DUE_CALLS_SCRIPT = `
local nowMs = ARGV[1]
local now = ARGV[2]
local limit = tonumber(ARGV[3])
local keyPrefix = ARGV[4]
local keySuffix = ARGV[5]
local callIds = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', nowMs, 'LIMIT', 0, limit)
local results = {}

for _, callId in ipairs(callIds) do
  local callKey = keyPrefix .. callId .. keySuffix
  local raw = redis.call('GET', callKey)
  if not raw then
    redis.call('ZREM', KEYS[1], callId)
  else
    local session = cjson.decode(raw)
    if (session.status == 'initiated' or session.status == 'ringing') and
       session.expiresAt and session.expiresAt <= now then
      session.status = 'ended'
      session.terminalReason = 'no_answer'
      session.terminalActorId = session.initiatorId
      session.terminalEventPublishedAt = cjson.null
      session.terminalEventPublishLeaseUntil = cjson.null
      session.endedAt = now
      session.updatedAt = now
      session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
      local ttl = redis.call('TTL', callKey)
      if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
      local encoded = cjson.encode(session)
      redis.call('SET', callKey, encoded, 'EX', ttl)
      redis.call('ZREM', KEYS[1], callId)
      redis.call('ZREM', KEYS[2], callId)
      redis.call('ZREM', KEYS[3], callId)
      redis.call('ZADD', KEYS[5], nowMs, callId)
      if redis.call('HGET', KEYS[4], session.initiatorId) == session.callId then
        redis.call('HDEL', KEYS[4], session.initiatorId)
      end
      if redis.call('HGET', KEYS[4], session.targetUserId) == session.callId then
        redis.call('HDEL', KEYS[4], session.targetUserId)
      end
      table.insert(results, encoded)
    elseif session.status == 'accepting' and session.answerLeaseExpiresAt and
       session.answerLeaseExpiresAt <= now then
      session.status = 'ended'
      session.terminalReason = 'media_unavailable'
      session.terminalActorId = session.targetUserId
      session.terminalEventPublishedAt = cjson.null
      session.terminalEventPublishLeaseUntil = cjson.null
      session.endedAt = now
      session.updatedAt = now
      session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
      local ttl = redis.call('TTL', callKey)
      if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
      local encoded = cjson.encode(session)
      redis.call('SET', callKey, encoded, 'EX', ttl)
      redis.call('ZREM', KEYS[1], callId)
      redis.call('ZREM', KEYS[2], callId)
      redis.call('ZREM', KEYS[3], callId)
      redis.call('ZADD', KEYS[5], nowMs, callId)
      if redis.call('HGET', KEYS[4], session.initiatorId) == session.callId then
        redis.call('HDEL', KEYS[4], session.initiatorId)
      end
      if redis.call('HGET', KEYS[4], session.targetUserId) == session.callId then
        redis.call('HDEL', KEYS[4], session.targetUserId)
      end
      table.insert(results, encoded)
    else
      redis.call('ZREM', KEYS[1], callId)
    end
  end
end

return results
`;

const TERMINATE_ACTIVE_CALLS_FOR_MEDIA_RESTART_SCRIPT = `
local now = ARGV[1]
local nowMs = ARGV[2]
local limit = tonumber(ARGV[3])
local keyPrefix = ARGV[4]
local keySuffix = ARGV[5]
local callIds = redis.call('ZRANGE', KEYS[1], 0, limit - 1)
local results = {}

for _, callId in ipairs(callIds) do
  local callKey = keyPrefix .. callId .. keySuffix
  local raw = redis.call('GET', callKey)
  if not raw then
    redis.call('ZREM', KEYS[1], callId)
  else
    local session = cjson.decode(raw)
    if session.status == 'active' then
      session.status = 'ended'
      session.terminalReason = 'media_unavailable'
      session.terminalActorId = session.initiatorId
      session.terminalEventPublishedAt = cjson.null
      session.terminalEventPublishLeaseUntil = cjson.null
      session.endedAt = now
      session.updatedAt = now
      session.lifecycleRevision = (session.lifecycleRevision or 0) + 1
      local ttl = redis.call('TTL', callKey)
      if ttl < 1 then ttl = ${SESSION_TTL_SECONDS} end
      local encoded = cjson.encode(session)
      redis.call('SET', callKey, encoded, 'EX', ttl)
      redis.call('ZREM', KEYS[1], callId)
      redis.call('ZREM', KEYS[2], callId)
      redis.call('ZADD', KEYS[4], nowMs, callId)
      if redis.call('HGET', KEYS[3], session.initiatorId) == session.callId then
        redis.call('HDEL', KEYS[3], session.initiatorId)
      end
      if redis.call('HGET', KEYS[3], session.targetUserId) == session.callId then
        redis.call('HDEL', KEYS[3], session.targetUserId)
      end
      table.insert(results, encoded)
    else
      redis.call('ZREM', KEYS[1], callId)
    end
  end
end

return results
`;

const CLEAR_ACTIVE_CALL_USER_INDEX_SCRIPT = `
local callId = ARGV[1]
local initiatorId = ARGV[2]
local targetUserId = ARGV[3]
if redis.call('HGET', KEYS[1], initiatorId) == callId then
  redis.call('HDEL', KEYS[1], initiatorId)
end
if redis.call('HGET', KEYS[1], targetUserId) == callId then
  redis.call('HDEL', KEYS[1], targetUserId)
end
return 1
`;

@Injectable()
export class RedisCallSessionRepository implements ICallSessionRepository {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async save(session: CallSession): Promise<CallSession> {
    const transaction = this.redis.multi();
    transaction.set(
      this.key(session.callId),
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );
    if (
      (session.status === 'initiated' || session.status === 'ringing') &&
      session.expiresAt
    ) {
      transaction.zadd(
        EXPIRING_CALLS_KEY,
        session.expiresAt.getTime(),
        session.callId,
      );
    } else if (session.status === 'accepting' && session.answerLeaseExpiresAt) {
      transaction.zadd(
        EXPIRING_CALLS_KEY,
        session.answerLeaseExpiresAt.getTime(),
        session.callId,
      );
    } else {
      transaction.zrem(EXPIRING_CALLS_KEY, session.callId);
    }
    if (session.status === 'active') {
      transaction.zadd(
        ACTIVE_CALLS_KEY,
        (session.answeredAt ?? session.updatedAt).getTime(),
        session.callId,
      );
      transaction.hset(
        ACTIVE_CALLS_BY_USER_KEY,
        session.initiatorId,
        session.callId,
      );
      transaction.hset(
        ACTIVE_CALLS_BY_USER_KEY,
        session.targetUserId,
        session.callId,
      );
    } else {
      transaction.zrem(ACTIVE_CALLS_KEY, session.callId);
    }
    if (
      session.status === 'ended' ||
      session.status === 'cancelled' ||
      session.status === 'rejected'
    ) {
      transaction.zrem(ANSWER_EVENT_OUTBOX_KEY, session.callId);
      transaction.zadd(
        TERMINAL_EVENT_OUTBOX_KEY,
        (session.endedAt ?? session.updatedAt).getTime(),
        session.callId,
      );
    } else {
      transaction.zrem(TERMINAL_EVENT_OUTBOX_KEY, session.callId);
    }
    await transaction.exec();
    if (this.isTerminal(session)) {
      await this.clearActiveUserIndex(session);
    }
    return session;
  }

  async findByCallId(callId: string): Promise<CallSession | null> {
    const raw = await this.redis.get(this.key(callId));
    if (!raw) return null;
    return this.toSession(raw);
  }

  async delete(callId: string): Promise<void> {
    const session = await this.findByCallId(callId);
    await this.redis
      .multi()
      .del(this.key(callId))
      .zrem(EXPIRING_CALLS_KEY, callId)
      .zrem(ANSWER_EVENT_OUTBOX_KEY, callId)
      .zrem(TERMINAL_EVENT_OUTBOX_KEY, callId)
      .zrem(ACTIVE_CALLS_KEY, callId)
      .exec();
    if (session) {
      await this.clearActiveUserIndex(session);
    }
  }

  async joinParticipant(
    callId: string,
    userId: string,
    now: Date,
  ): Promise<CallJoinTransition> {
    const [outcome, raw, joinedNow] = await this.runTransition(
      JOIN_PARTICIPANT_SCRIPT,
      callId,
      now.toISOString(),
      userId,
      String(now.getTime()),
    );
    return {
      outcome: outcome as CallJoinTransition['outcome'],
      session: this.toSession(raw),
      joinedNow: joinedNow === '1',
    };
  }

  async claimIncomingAnswer(
    callId: string,
    userId: string,
    actionId: string,
    now: Date,
  ): Promise<CallAnswerTransition> {
    const acceptingLeaseUntil = new Date(
      now.getTime() + ANSWER_ACCEPT_LEASE_MS,
    ).toISOString();
    const [outcome, raw, shouldPublishEvent] = await this.runTransition(
      CLAIM_INCOMING_ANSWER_SCRIPT,
      callId,
      now.toISOString(),
      userId,
      actionId,
      acceptingLeaseUntil,
      String(now.getTime() + ANSWER_ACCEPT_LEASE_MS),
      String(now.getTime()),
    );
    return {
      outcome: outcome as CallAnswerTransition['outcome'],
      session: this.toSession(raw),
      shouldPublishEvent: shouldPublishEvent === '1',
    };
  }

  async activateIncomingAnswer(
    callId: string,
    userId: string,
    actionId: string,
    now: Date,
  ): Promise<CallActivationTransition> {
    const [outcome, raw] = await this.runTransition(
      ACTIVATE_INCOMING_ANSWER_SCRIPT,
      callId,
      now.toISOString(),
      String(now.getTime()),
      userId,
      actionId,
    );
    return {
      outcome: outcome as CallActivationTransition['outcome'],
      session: this.toSession(raw),
    };
  }

  async claimPendingAnswerEvents(
    now: Date,
    limit: number,
  ): Promise<CallAnswerOutboxEvent[]> {
    const leaseUntil = new Date(
      now.getTime() + ANSWER_EVENT_PUBLICATION_LEASE_MS,
    );
    const result = await this.redis.eval(
      CLAIM_PENDING_ANSWER_EVENTS_SCRIPT,
      1,
      ANSWER_EVENT_OUTBOX_KEY,
      String(now.getTime()),
      now.toISOString(),
      String(leaseUntil.getTime()),
      leaseUntil.toISOString(),
      String(Math.max(1, limit)),
      'call:',
      ':session',
    );
    if (!Array.isArray(result)) {
      throw new Error('Invalid call answer outbox transition result');
    }
    return result
      .map((raw) => this.toSession(String(raw)))
      .filter((session): session is CallSession =>
        Boolean(session?.answerActionId),
      )
      .map((session) => ({ session, actionId: session.answerActionId! }));
  }

  async markAnswerEventPublished(
    callId: string,
    actionId: string,
    now: Date,
  ): Promise<void> {
    await this.redis.eval(
      MARK_ANSWER_EVENT_PUBLISHED_SCRIPT,
      2,
      this.key(callId),
      ANSWER_EVENT_OUTBOX_KEY,
      actionId,
      now.toISOString(),
    );
  }

  async claimPendingTerminalEvents(
    now: Date,
    limit: number,
  ): Promise<CallTerminalOutboxEvent[]> {
    const leaseUntil = new Date(
      now.getTime() + TERMINAL_EVENT_PUBLICATION_LEASE_MS,
    );
    const result = await this.redis.eval(
      CLAIM_PENDING_TERMINAL_EVENTS_SCRIPT,
      1,
      TERMINAL_EVENT_OUTBOX_KEY,
      String(now.getTime()),
      now.toISOString(),
      String(leaseUntil.getTime()),
      leaseUntil.toISOString(),
      String(Math.max(1, limit)),
      'call:',
      ':session',
    );
    if (!Array.isArray(result)) {
      throw new Error('Invalid call terminal outbox transition result');
    }

    return result
      .map((raw) => this.toSession(String(raw)))
      .filter((session): session is CallSession =>
        Boolean(session && this.isTerminal(session)),
      )
      .map((session) => ({
        session,
        event: session.status === 'rejected' ? 'call.rejected' : 'call.ended',
        reason: session.terminalReason ?? 'ended',
        userId:
          session.terminalActorId ??
          (session.status === 'rejected'
            ? session.targetUserId
            : session.initiatorId),
      }));
  }

  async markTerminalEventPublished(
    callId: string,
    lifecycleRevision: number,
    now: Date,
  ): Promise<void> {
    await this.redis.eval(
      MARK_TERMINAL_EVENT_PUBLISHED_SCRIPT,
      2,
      this.key(callId),
      TERMINAL_EVENT_OUTBOX_KEY,
      String(lifecycleRevision),
      now.toISOString(),
    );
  }

  async transitionToTerminal(
    callId: string,
    userId: string,
    requestedReason: string | undefined,
    now: Date,
    mode: 'leave' | 'reject' | 'accept_failure',
    expectedAnswerActionId?: string,
  ): Promise<CallTerminalTransition> {
    const [outcome, raw, reason, wasActive] = await this.runTransition(
      TRANSITION_TO_TERMINAL_SCRIPT,
      callId,
      userId,
      requestedReason ?? '',
      now.toISOString(),
      mode,
      String(now.getTime()),
      expectedAnswerActionId ?? '',
    );
    return {
      outcome: outcome as CallTerminalTransition['outcome'],
      session: this.toSession(raw),
      ...(reason ? { reason } : {}),
      wasActive: wasActive === '1',
    };
  }

  async expireDueCalls(
    now: Date,
    limit: number,
  ): Promise<CallExpiryTransition[]> {
    const result = await this.redis.eval(
      EXPIRE_DUE_CALLS_SCRIPT,
      5,
      EXPIRING_CALLS_KEY,
      ANSWER_EVENT_OUTBOX_KEY,
      ACTIVE_CALLS_KEY,
      ACTIVE_CALLS_BY_USER_KEY,
      TERMINAL_EVENT_OUTBOX_KEY,
      String(now.getTime()),
      now.toISOString(),
      String(Math.max(1, limit)),
      'call:',
      ':session',
    );
    if (!Array.isArray(result)) {
      throw new Error('Invalid call expiry transition result');
    }
    return result
      .map((raw) => this.toSession(String(raw)))
      .filter((session): session is CallSession => session !== null)
      .map((session) => ({
        session,
        reason:
          session.terminalReason === 'media_unavailable'
            ? 'media_unavailable'
            : 'no_answer',
      }));
  }

  async terminateActiveCallsForMediaRestart(
    now: Date,
    limit: number,
  ): Promise<CallSession[]> {
    const result = await this.redis.eval(
      TERMINATE_ACTIVE_CALLS_FOR_MEDIA_RESTART_SCRIPT,
      4,
      ACTIVE_CALLS_KEY,
      ANSWER_EVENT_OUTBOX_KEY,
      ACTIVE_CALLS_BY_USER_KEY,
      TERMINAL_EVENT_OUTBOX_KEY,
      now.toISOString(),
      String(now.getTime()),
      String(Math.max(1, limit)),
      'call:',
      ':session',
    );
    if (!Array.isArray(result)) {
      throw new Error('Invalid active media restart transition result');
    }
    return result
      .map((raw) => this.toSession(String(raw)))
      .filter((session): session is CallSession => session !== null);
  }

  private async runTransition(
    script: string,
    callId: string,
    ...args: string[]
  ): Promise<string[]> {
    const result = await this.redis.eval(
      script,
      6,
      this.key(callId),
      EXPIRING_CALLS_KEY,
      ANSWER_EVENT_OUTBOX_KEY,
      ACTIVE_CALLS_KEY,
      ACTIVE_CALLS_BY_USER_KEY,
      TERMINAL_EVENT_OUTBOX_KEY,
      ...args,
    );
    if (!Array.isArray(result)) {
      throw new Error('Invalid call lifecycle transition result');
    }
    return result.map((value) => String(value));
  }

  private toSession(raw?: string): CallSession | null {
    if (!raw) return null;
    return new CallSession(JSON.parse(raw) as Partial<CallSession>);
  }

  private key(callId: string): string {
    return `call:${callId}:session`;
  }

  private isTerminal(session: CallSession): boolean {
    return ['ended', 'cancelled', 'rejected'].includes(session.status);
  }

  private async clearActiveUserIndex(session: CallSession): Promise<void> {
    await this.redis.eval(
      CLEAR_ACTIVE_CALL_USER_INDEX_SCRIPT,
      1,
      ACTIVE_CALLS_BY_USER_KEY,
      session.callId,
      session.initiatorId,
      session.targetUserId,
    );
  }
}
