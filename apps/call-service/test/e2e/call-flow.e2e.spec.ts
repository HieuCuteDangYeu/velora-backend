import { of, throwError } from 'rxjs';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { CallGateway } from '../../src/infrastructure/gateways/call.gateway';
import { CallServiceModule } from '../../src/call-service.module';
import { PublishCallAnswerOutboxUseCase } from '../../src/application/use-cases/publish-call-answer-outbox.use-case';
import { PublishCallTerminalOutboxUseCase } from '../../src/application/use-cases/publish-call-terminal-outbox.use-case';
import type { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import type {
  ActiveProducerResult,
  ConsumedMediaResult,
  CreateRecvTransportResult,
  CreateSendTransportResult,
  ProducedMediaResult,
  RouterRtpCapabilitiesResult,
} from '../../src/domain/interfaces/call-media.engine.interface';

// This is only the in-process Socket.IO test harness. A short fixed timeout
// flakes when Jest is concurrently tearing down another Nest application; it
// is deliberately unrelated to the production call-answer watchdog.
const SOCKET_EVENT_TIMEOUT_MS = 5_000;

type RoomState = {
  transports: Map<
    string,
    {
      userId: string;
      direction: 'send' | 'recv';
      connected: boolean;
      closed: boolean;
    }
  >;
  producers: Map<
    string,
    {
      userId: string;
      transportId: string;
      kind: 'audio' | 'video';
      paused: boolean;
      closed: boolean;
    }
  >;
  consumers: Map<
    string,
    {
      userId: string;
      transportId: string;
      producerId: string;
      paused: boolean;
      closed: boolean;
    }
  >;
};

class FakeRedisClient {
  private readonly values = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.values.has(key)) {
      return Promise.resolve(null);
    }
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      deleted += Number(this.values.delete(key));
      deleted += Number(this.hashes.delete(key));
      deleted += Number(this.sets.delete(key));
      deleted += Number(this.sortedSets.delete(key));
    }
    return Promise.resolve(deleted);
  }

  hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    this.hashes.set(key, hash);
    return Promise.resolve(1);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    return Promise.resolve(Object.fromEntries(hash.entries()));
  }

  hget(key: string, field: string): Promise<string | null> {
    const hash = this.hashes.get(key);
    return Promise.resolve(hash?.get(field) ?? null);
  }

  hdel(key: string, field: string): Promise<number> {
    const hash = this.hashes.get(key);
    if (!hash) return Promise.resolve(0);
    const deleted = hash.delete(field) ? 1 : 0;
    if (hash.size === 0) {
      this.hashes.delete(key);
    }
    return Promise.resolve(deleted);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  ttl(): Promise<number> {
    return Promise.resolve(60 * 60);
  }

  zadd(key: string, score: number | string, member: string): Promise<number> {
    const values = this.sortedSets.get(key) ?? new Map<string, number>();
    const existed = values.has(member);
    values.set(member, Number(score));
    this.sortedSets.set(key, values);
    return Promise.resolve(existed ? 0 : 1);
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    const values = this.sortedSets.get(key);
    if (!values) return Promise.resolve(0);

    let deleted = 0;
    for (const member of members) {
      deleted += Number(values.delete(member));
    }
    if (values.size === 0) {
      this.sortedSets.delete(key);
    }
    return Promise.resolve(deleted);
  }

  multi() {
    const commands: Array<() => Promise<unknown>> = [];
    const transaction = {
      set: (...args: [string, string, ...unknown[]]) => {
        commands.push(() => this.set(...args));
        return transaction;
      },
      del: (...keys: string[]) => {
        commands.push(() => this.del(...keys));
        return transaction;
      },
      zadd: (key: string, score: number | string, member: string) => {
        commands.push(() => this.zadd(key, score, member));
        return transaction;
      },
      zrem: (key: string, ...members: string[]) => {
        commands.push(() => this.zrem(key, ...members));
        return transaction;
      },
      hset: (key: string, field: string, value: string) => {
        commands.push(() => this.hset(key, field, value));
        return transaction;
      },
      exec: async () =>
        Promise.all(commands.map(async (command) => [null, await command()])),
    };
    return transaction;
  }

  eval(
    script: string,
    keyCount: number,
    ...values: string[]
  ): Promise<unknown> {
    const keys = values.slice(0, keyCount);
    const args = values.slice(keyCount);

    if (script.includes("redis.call('PEXPIRE', KEYS[1], ARGV[2])")) {
      return Promise.resolve(this.values.get(keys[0]) === args[0] ? 1 : 0);
    }
    if (script.includes("redis.call('DEL', KEYS[1])")) {
      if (this.values.get(keys[0]) !== args[0]) return Promise.resolve(0);
      this.values.delete(keys[0]);
      return Promise.resolve(1);
    }
    if (script.includes('local joinedNow = true')) {
      return Promise.resolve(this.evalJoin(keys, args));
    }
    if (script.includes('local acceptingLeaseUntil = ARGV[4]')) {
      return Promise.resolve(this.evalClaimIncomingAnswer(keys, args));
    }
    if (script.includes("session.status = 'active'")) {
      return Promise.resolve(this.evalActivateIncomingAnswer(keys, args));
    }
    if (script.includes('local requestedReason = ARGV[2]')) {
      return Promise.resolve(this.evalTerminalTransition(keys, args));
    }
    if (script.includes("session.terminalReason = 'no_answer'")) {
      return Promise.resolve(this.evalExpireDueCalls(keys, args));
    }
    if (script.includes("local callIds = redis.call('ZRANGE'")) {
      return Promise.resolve(
        this.evalTerminateActiveCallsForMediaRestart(keys, args),
      );
    }
    if (script.includes('session.terminalEventPublishedAt = ARGV[2]')) {
      return Promise.resolve(this.evalMarkTerminalPublished(keys, args));
    }
    if (script.includes('terminalEventPublishLeaseUntil')) {
      return Promise.resolve(this.evalClaimPendingTerminalEvents(keys, args));
    }
    if (script.includes('local leaseUntilMs = ARGV[3]')) {
      return Promise.resolve(this.evalClaimPendingAnswerEvents(keys, args));
    }
    if (script.includes('session.answerEventPublishedAt = ARGV[2]')) {
      return Promise.resolve(this.evalMarkAnswerPublished(keys, args));
    }
    if (script.includes("local callIds = redis.call('ZRANGE'")) {
      return Promise.resolve(
        this.evalTerminateActiveCallsForMediaRestart(keys, args),
      );
    }
    if (script.includes("local callIds = redis.call('ZRANGEBYSCORE'")) {
      return Promise.resolve(this.evalExpireDueCalls(keys, args));
    }
    if (script.includes('local targetUserId = ARGV[3]')) {
      return Promise.resolve(this.evalClearActiveCallForUsers(keys, args));
    }

    throw new Error('Unsupported Redis Lua script in call-flow test');
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    this.sets.set(key, set);
    return Promise.resolve(added);
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.sets.get(key) ?? new Set<string>())]);
  }

  ping(): Promise<'PONG'> {
    return Promise.resolve('PONG');
  }

  disconnect(): void {}

  reset(): void {
    this.values.clear();
    this.hashes.clear();
    this.sets.clear();
    this.sortedSets.clear();
  }

  private evalJoin(keys: string[], args: string[]): string[] {
    const [key] = keys;
    const raw = this.values.get(key);
    if (!raw) return ['not_found'];

    const session = this.readSession(raw);
    const [now, userId, nowMs] = args;
    if (this.isRingingExpired(session, now)) {
      return [
        'expired',
        this.terminalizeExpiredSession(keys, session, now, nowMs),
        '0',
      ];
    }
    if (userId !== session.initiatorId && userId !== session.targetUserId) {
      return ['forbidden', raw, '0'];
    }
    if (this.isTerminal(session)) {
      return ['terminal', raw, '0'];
    }

    const participantIds = this.participantIds(session);
    const joinedNow = !participantIds.includes(userId);
    if (joinedNow) {
      participantIds.push(userId);
    }
    session.participantIds = participantIds;
    if (userId === session.targetUserId && session.status === 'initiated') {
      session.status = 'ringing';
    }
    session.updatedAt = now;
    session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
    return ['joined', this.writeSession(key, session), joinedNow ? '1' : '0'];
  }

  private evalClaimIncomingAnswer(keys: string[], args: string[]): string[] {
    const [key, expiryKey, , , activeUsersKey] = keys;
    const raw = this.values.get(key);
    if (!raw) return ['not_found'];

    const session = this.readSession(raw);
    const [
      now,
      userId,
      actionId,
      acceptingLeaseUntil,
      acceptingLeaseUntilMs,
      nowMs,
    ] = args;
    if (userId !== session.targetUserId) {
      return ['forbidden', raw, '0'];
    }
    if (this.isRingingExpired(session, now)) {
      return [
        'expired',
        this.terminalizeExpiredSession(keys, session, now, nowMs),
        '0',
      ];
    }
    if (session.status === 'accepting' || session.status === 'active') {
      if (session.answerActionId === actionId) {
        return ['already_accepted', raw, '0'];
      }
      return ['answered_elsewhere', raw, '0'];
    }
    if (this.isTerminal(session)) {
      return ['terminal', raw, '0'];
    }
    if (this.hasOtherActiveCall(activeUsersKey, session)) {
      return ['busy', raw, '0'];
    }

    const participantIds = this.participantIds(session);
    if (!participantIds.includes(userId)) {
      participantIds.push(userId);
    }
    session.participantIds = participantIds;
    session.status = 'accepting';
    session.answerActionId = actionId;
    session.answerLeaseExpiresAt = acceptingLeaseUntil;
    session.answeredAt = now;
    session.updatedAt = now;
    session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
    void this.zadd(expiryKey, acceptingLeaseUntilMs, String(session.callId));
    return ['accepted', this.writeSession(key, session), '0'];
  }

  private terminalizeExpiredSession(
    keys: string[],
    session: Record<string, unknown>,
    now: string,
    nowMs: string | undefined,
  ): string {
    const [
      key,
      expiryKey,
      answerOutboxKey,
      activeKey,
      activeUsersKey,
      terminalOutboxKey,
    ] = keys;
    session.status = 'ended';
    session.terminalReason = 'no_answer';
    session.terminalActorId = session.initiatorId;
    session.terminalEventPublishedAt = null;
    session.terminalEventPublishLeaseUntil = null;
    session.endedAt = now;
    session.updatedAt = now;
    session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
    void this.zrem(expiryKey, String(session.callId));
    void this.zrem(answerOutboxKey, String(session.callId));
    void this.zrem(activeKey, String(session.callId));
    void this.zadd(
      terminalOutboxKey,
      Number(nowMs ?? Date.parse(now)),
      String(session.callId),
    );
    this.clearActiveCallForSession(activeUsersKey, session);
    return this.writeSession(key, session);
  }

  private evalActivateIncomingAnswer(keys: string[], args: string[]): string[] {
    const [
      key,
      expiryKey,
      outboxKey,
      activeKey,
      activeUsersKey,
      terminalOutboxKey,
    ] = keys;
    const raw = this.values.get(key);
    if (!raw) return ['not_found'];

    const session = this.readSession(raw);
    const [now, nowMs, userId, actionId] = args;
    if (userId !== session.targetUserId) {
      return ['forbidden', raw];
    }
    if (session.status === 'active') {
      return session.answerActionId === actionId
        ? ['already_accepted', raw]
        : ['answered_elsewhere', raw];
    }
    if (this.isTerminal(session)) {
      return ['terminal', raw];
    }
    if (session.status !== 'accepting' || session.answerActionId !== actionId) {
      return ['answered_elsewhere', raw];
    }
    if (this.hasOtherActiveCall(activeUsersKey, session)) {
      return ['busy', raw];
    }
    if (
      typeof session.answerLeaseExpiresAt === 'string' &&
      Date.parse(session.answerLeaseExpiresAt) <= Date.parse(now)
    ) {
      session.status = 'ended';
      session.terminalReason = 'media_unavailable';
      session.terminalActorId = userId;
      session.terminalEventPublishedAt = null;
      session.terminalEventPublishLeaseUntil = null;
      session.endedAt = now;
      session.updatedAt = now;
      session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
      void this.zrem(expiryKey, String(session.callId));
      void this.zrem(outboxKey, String(session.callId));
      void this.zrem(activeKey, String(session.callId));
      void this.zadd(terminalOutboxKey, nowMs, String(session.callId));
      this.clearActiveCallForSession(activeUsersKey, session);
      return ['terminal', this.writeSession(key, session)];
    }

    session.status = 'active';
    session.answerLeaseExpiresAt = null;
    session.answerEventPublishedAt = null;
    session.answerEventPublishLeaseUntil = null;
    session.updatedAt = now;
    session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
    const encoded = this.writeSession(key, session);
    void this.zrem(expiryKey, String(session.callId));
    void this.zadd(outboxKey, nowMs, String(session.callId));
    void this.zadd(activeKey, nowMs, String(session.callId));
    this.setActiveCallForSession(activeUsersKey, session);
    return ['accepted', encoded];
  }

  private evalClaimPendingAnswerEvents(
    keys: string[],
    args: string[],
  ): string[] {
    const [outboxKey] = keys;
    const [
      nowMsRaw,
      now,
      leaseUntilMs,
      leaseUntil,
      rawLimit,
      keyPrefix,
      keySuffix,
    ] = args;
    const callIds = this.sortedMembersAtOrBefore(
      outboxKey,
      Number(nowMsRaw),
      Number(rawLimit),
    );
    const results: string[] = [];

    for (const callId of callIds) {
      const key = `${keyPrefix}${callId}${keySuffix}`;
      const raw = this.values.get(key);
      if (!raw) {
        void this.zrem(outboxKey, callId);
        continue;
      }
      const session = this.readSession(raw);
      const eventPending = !session.answerEventPublishedAt;
      const leaseExpired =
        !session.answerEventPublishLeaseUntil ||
        (typeof session.answerEventPublishLeaseUntil === 'string' &&
          session.answerEventPublishLeaseUntil <= now);
      if (
        session.status === 'active' &&
        session.answerActionId &&
        eventPending &&
        leaseExpired
      ) {
        session.answerEventPublishLeaseUntil = leaseUntil;
        session.updatedAt = now;
        results.push(this.writeSession(key, session));
        void this.zadd(outboxKey, leaseUntilMs, callId);
      } else if (session.status !== 'active' || !eventPending) {
        void this.zrem(outboxKey, callId);
      }
    }

    return results;
  }

  private evalMarkAnswerPublished(keys: string[], args: string[]): number {
    const [key, outboxKey] = keys;
    const raw = this.values.get(key);
    if (!raw) return 0;

    const session = this.readSession(raw);
    const [actionId, now] = args;
    if (session.answerActionId !== actionId || session.answerEventPublishedAt) {
      return 0;
    }
    session.answerEventPublishedAt = now;
    session.answerEventPublishLeaseUntil = null;
    session.updatedAt = now;
    this.writeSession(key, session);
    void this.zrem(outboxKey, String(session.callId));
    return 1;
  }

  private evalClaimPendingTerminalEvents(
    keys: string[],
    args: string[],
  ): string[] {
    const [outboxKey] = keys;
    const [
      nowMsRaw,
      now,
      leaseUntilMs,
      leaseUntil,
      rawLimit,
      keyPrefix,
      keySuffix,
    ] = args;
    const callIds = this.sortedMembersAtOrBefore(
      outboxKey,
      Number(nowMsRaw),
      Number(rawLimit),
    );
    const results: string[] = [];

    for (const callId of callIds) {
      const key = `${keyPrefix}${callId}${keySuffix}`;
      const raw = this.values.get(key);
      if (!raw) {
        void this.zrem(outboxKey, callId);
        continue;
      }

      const session = this.readSession(raw);
      const eventPending = !session.terminalEventPublishedAt;
      const leaseExpired =
        !session.terminalEventPublishLeaseUntil ||
        (typeof session.terminalEventPublishLeaseUntil === 'string' &&
          session.terminalEventPublishLeaseUntil <= now);
      if (this.isTerminal(session) && eventPending && leaseExpired) {
        session.terminalEventPublishLeaseUntil = leaseUntil;
        session.updatedAt = now;
        results.push(this.writeSession(key, session));
        void this.zadd(outboxKey, leaseUntilMs, callId);
      } else if (!this.isTerminal(session) || !eventPending) {
        void this.zrem(outboxKey, callId);
      }
    }

    return results;
  }

  private evalMarkTerminalPublished(keys: string[], args: string[]): number {
    const [key, outboxKey] = keys;
    const raw = this.values.get(key);
    if (!raw) return 0;

    const session = this.readSession(raw);
    const [lifecycleRevision, now] = args;
    if (
      !this.isTerminal(session) ||
      this.scalarString(session.lifecycleRevision, '0') !== lifecycleRevision ||
      session.terminalEventPublishedAt
    ) {
      return 0;
    }
    session.terminalEventPublishedAt = now;
    session.terminalEventPublishLeaseUntil = null;
    session.updatedAt = now;
    this.writeSession(key, session);
    void this.zrem(outboxKey, String(session.callId));
    return 1;
  }

  private evalTerminalTransition(keys: string[], args: string[]): string[] {
    const [
      key,
      expiryKey,
      outboxKey,
      activeKey,
      activeUsersKey,
      terminalOutboxKey,
    ] = keys;
    const raw = this.values.get(key);
    if (!raw) return ['not_found'];

    const session = this.readSession(raw);
    const [userId, requestedReason, now, mode, nowMs] = args;
    const wasActive = session.status === 'active';
    if (mode === 'reject') {
      if (userId !== session.targetUserId) {
        return ['forbidden', raw, '', '0'];
      }
      if (wasActive) {
        return ['active', raw, '', '1'];
      }
      if (this.isTerminal(session)) {
        return [
          'already_terminal',
          raw,
          this.scalarString(session.terminalReason),
          '0',
        ];
      }
      session.status = 'rejected';
      session.terminalReason = requestedReason || 'rejected';
    } else {
      if (!this.participantIds(session).includes(userId)) {
        return ['forbidden', raw, '', '0'];
      }
      if (this.isTerminal(session)) {
        return [
          'already_terminal',
          raw,
          this.scalarString(session.terminalReason),
          '0',
        ];
      }
      const reason =
        requestedReason ||
        (wasActive || userId !== session.initiatorId ? 'ended' : 'cancelled');
      session.status = reason === 'cancelled' ? 'cancelled' : 'ended';
      session.terminalReason = reason;
    }

    session.endedAt = now;
    session.updatedAt = now;
    session.terminalActorId = userId;
    session.terminalEventPublishedAt = null;
    session.terminalEventPublishLeaseUntil = null;
    session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
    void this.zrem(expiryKey, session.callId as string);
    void this.zrem(outboxKey, String(session.callId));
    void this.zrem(activeKey, String(session.callId));
    void this.zadd(terminalOutboxKey, nowMs, String(session.callId));
    this.clearActiveCallForSession(activeUsersKey, session);
    return [
      'transitioned',
      this.writeSession(key, session),
      this.scalarString(session.terminalReason),
      wasActive ? '1' : '0',
    ];
  }

  private evalExpireDueCalls(keys: string[], args: string[]): string[] {
    const [expiryKey, outboxKey, activeKey, activeUsersKey, terminalOutboxKey] =
      keys;
    const [nowMsRaw, now, rawLimit, keyPrefix, keySuffix] = args;
    const nowMs = Number(nowMsRaw);
    const limit = Number(rawLimit);
    const callIds = this.sortedMembersAtOrBefore(expiryKey, nowMs, limit);
    const results: string[] = [];

    for (const callId of callIds) {
      const key = `${keyPrefix}${callId}${keySuffix}`;
      const raw = this.values.get(key);
      if (!raw) {
        void this.zrem(expiryKey, callId);
        continue;
      }

      const session = this.readSession(raw);
      if (this.isRingingExpired(session, now)) {
        session.status = 'ended';
        session.terminalReason = 'no_answer';
        session.terminalActorId = session.initiatorId;
        session.terminalEventPublishedAt = null;
        session.terminalEventPublishLeaseUntil = null;
        session.endedAt = now;
        session.updatedAt = now;
        session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
        void this.zadd(terminalOutboxKey, nowMs, callId);
        results.push(this.writeSession(key, session));
      } else if (
        session.status === 'accepting' &&
        typeof session.answerLeaseExpiresAt === 'string' &&
        Date.parse(session.answerLeaseExpiresAt) <= nowMs
      ) {
        session.status = 'ended';
        session.terminalReason = 'media_unavailable';
        session.terminalActorId = session.targetUserId;
        session.terminalEventPublishedAt = null;
        session.terminalEventPublishLeaseUntil = null;
        session.endedAt = now;
        session.updatedAt = now;
        session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
        void this.zadd(terminalOutboxKey, nowMs, callId);
        results.push(this.writeSession(key, session));
      }
      void this.zrem(expiryKey, callId);
      void this.zrem(outboxKey, callId);
      void this.zrem(activeKey, callId);
      this.clearActiveCallForSession(activeUsersKey, session);
    }

    return results;
  }

  private evalTerminateActiveCallsForMediaRestart(
    keys: string[],
    args: string[],
  ): string[] {
    const [activeKey, outboxKey, activeUsersKey, terminalOutboxKey] = keys;
    const [now, nowMs, rawLimit, keyPrefix, keySuffix] = args;
    const callIds = [
      ...(
        this.sortedSets.get(activeKey) ?? new Map<string, number>()
      ).entries(),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, Number(rawLimit))
      .map(([callId]) => callId);
    const results: string[] = [];

    for (const callId of callIds) {
      const key = `${keyPrefix}${callId}${keySuffix}`;
      const raw = this.values.get(key);
      if (!raw) {
        void this.zrem(activeKey, callId);
        continue;
      }
      const session = this.readSession(raw);
      if (session.status === 'active') {
        session.status = 'ended';
        session.terminalReason = 'media_unavailable';
        session.terminalActorId = session.initiatorId;
        session.terminalEventPublishedAt = null;
        session.terminalEventPublishLeaseUntil = null;
        session.endedAt = now;
        session.updatedAt = now;
        session.lifecycleRevision = Number(session.lifecycleRevision ?? 0) + 1;
        void this.zadd(terminalOutboxKey, nowMs, callId);
        results.push(this.writeSession(key, session));
      }
      void this.zrem(activeKey, callId);
      void this.zrem(outboxKey, callId);
      this.clearActiveCallForSession(activeUsersKey, session);
    }

    return results;
  }

  private sortedMembersAtOrBefore(
    key: string,
    maxScore: number,
    limit: number,
  ): string[] {
    return [
      ...(this.sortedSets.get(key) ?? new Map<string, number>()).entries(),
    ]
      .filter(([, score]) => score <= maxScore)
      .sort(([leftMember, leftScore], [rightMember, rightScore]) =>
        leftScore === rightScore
          ? leftMember.localeCompare(rightMember)
          : leftScore - rightScore,
      )
      .slice(0, limit)
      .map(([member]) => member);
  }

  private hasOtherActiveCall(
    activeUsersKey: string | undefined,
    session: Record<string, unknown>,
  ): boolean {
    if (!activeUsersKey) return false;
    const activeUsers = this.hashes.get(activeUsersKey);
    const callId = String(session.callId);
    return [String(session.initiatorId), String(session.targetUserId)].some(
      (userId) => {
        const activeCallId = activeUsers?.get(userId);
        return Boolean(activeCallId && activeCallId !== callId);
      },
    );
  }

  private setActiveCallForSession(
    activeUsersKey: string | undefined,
    session: Record<string, unknown>,
  ): void {
    if (!activeUsersKey) return;
    const activeUsers =
      this.hashes.get(activeUsersKey) ?? new Map<string, string>();
    const callId = String(session.callId);
    activeUsers.set(String(session.initiatorId), callId);
    activeUsers.set(String(session.targetUserId), callId);
    this.hashes.set(activeUsersKey, activeUsers);
  }

  private clearActiveCallForSession(
    activeUsersKey: string | undefined,
    session: Record<string, unknown>,
  ): void {
    if (!activeUsersKey) return;
    const activeUsers = this.hashes.get(activeUsersKey);
    if (!activeUsers) return;
    const callId = String(session.callId);
    for (const userId of [
      String(session.initiatorId),
      String(session.targetUserId),
    ]) {
      if (activeUsers.get(userId) === callId) {
        activeUsers.delete(userId);
      }
    }
    if (activeUsers.size === 0) {
      this.hashes.delete(activeUsersKey);
    }
  }

  private evalClearActiveCallForUsers(keys: string[], args: string[]): number {
    const [activeUsersKey] = keys;
    const [callId, initiatorId, targetUserId] = args;
    const activeUsers = this.hashes.get(activeUsersKey);
    if (!activeUsers) return 1;
    for (const userId of [initiatorId, targetUserId]) {
      if (activeUsers.get(userId) === callId) {
        activeUsers.delete(userId);
      }
    }
    if (activeUsers.size === 0) {
      this.hashes.delete(activeUsersKey);
    }
    return 1;
  }

  private readSession(raw: string): Record<string, unknown> {
    return JSON.parse(raw) as Record<string, unknown>;
  }

  private scalarString(value: unknown, fallback = ''): string {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : fallback;
  }

  private writeSession(key: string, session: Record<string, unknown>): string {
    const raw = JSON.stringify(session);
    this.values.set(key, raw);
    return raw;
  }

  private participantIds(session: Record<string, unknown>): string[] {
    return Array.isArray(session.participantIds)
      ? (session.participantIds as string[])
      : [];
  }

  private isTerminal(session: Record<string, unknown>): boolean {
    return ['ended', 'cancelled', 'rejected'].includes(String(session.status));
  }

  private isRingingExpired(
    session: Record<string, unknown>,
    now: string,
  ): boolean {
    return (
      (session.status === 'initiated' || session.status === 'ringing') &&
      typeof session.expiresAt === 'string' &&
      Date.parse(session.expiresAt) <= Date.parse(now)
    );
  }
}

class FakeCallEventPublisher {
  readonly events: Array<{ event: string; payload: Record<string, unknown> }> =
    [];
  private nextError?: Error;

  publish(event: string, payload: Record<string, unknown>): Promise<void> {
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      return Promise.reject(error);
    }
    this.events.push({ event, payload });
    return Promise.resolve();
  }

  failNextPublish(error = new Error('RabbitMQ unavailable')): void {
    this.nextError = error;
  }

  reset(): void {
    this.events.length = 0;
    this.nextError = undefined;
  }
}

class FakeAuthClient {
  constructor(private readonly usersByToken: Record<string, AuthUser>) {}

  send(pattern: string, payload: { token: string }) {
    if (pattern !== 'auth.verify_token') {
      return of(null);
    }

    return of(this.usersByToken[payload.token] ?? null);
  }
}

type ConversationDetail = {
  id: string;
  participantIds: string[];
  isGroup: boolean;
};

class FakeConversationClient {
  constructor(
    private readonly conversationsById: Record<string, ConversationDetail>,
  ) {}

  send(pattern: string, payload: { id: string; userId: string }) {
    if (pattern !== 'get_conversation_detail') {
      return of(null);
    }

    const conversation = this.conversationsById[payload.id];
    if (!conversation) {
      return throwError(() => new Error('Conversation not found'));
    }

    if (!conversation.participantIds.includes(payload.userId)) {
      return throwError(
        () => new Error('You are not a participant of this conversation'),
      );
    }

    return of(conversation);
  }
}

class FakeCallMediaEngine {
  private roomCounter = 0;
  private transportCounter = 0;
  private producerCounter = 0;
  private consumerCounter = 0;
  private readonly rooms = new Map<string, RoomState>();

  createRoom(callId: string): Promise<void> {
    if (!this.rooms.has(callId)) {
      this.roomCounter += 1;
      this.rooms.set(callId, {
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      });
    }
    return Promise.resolve();
  }

  getRouterRtpCapabilities(): Promise<RouterRtpCapabilitiesResult> {
    return Promise.resolve({
      codecs: [{ mimeType: 'audio/opus' }, { mimeType: 'video/VP8' }],
      headerExtensions: [{ uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
    });
  }

  createSendTransport(
    callId: string,
    userId: string,
  ): Promise<CreateSendTransportResult> {
    return this.createTransport(callId, userId, 'send');
  }

  createRecvTransport(
    callId: string,
    userId: string,
  ): Promise<CreateRecvTransportResult> {
    return this.createTransport(callId, userId, 'recv');
  }

  connectTransport(
    callId: string,
    userId: string,
    transportId: string,
  ): Promise<void> {
    const room = this.getRoom(callId);
    const transport = room.transports.get(transportId);
    if (!transport || transport.userId !== userId) {
      throw new Error('Transport not found');
    }
    transport.connected = true;
    return Promise.resolve();
  }

  produce(
    callId: string,
    userId: string,
    transportId: string,
    kind: 'audio' | 'video',
  ): Promise<ProducedMediaResult> {
    const room = this.getRoom(callId);
    const transport = room.transports.get(transportId);
    if (
      !transport ||
      transport.userId !== userId ||
      transport.direction !== 'send' ||
      !transport.connected
    ) {
      throw new Error('Send transport is not connected');
    }

    this.producerCounter += 1;
    const producerId = `producer-${this.producerCounter}`;
    room.producers.set(producerId, {
      userId,
      transportId,
      kind,
      paused: false,
      closed: false,
    });
    return Promise.resolve({ producerId });
  }

  consume(
    callId: string,
    userId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Record<string, unknown>,
  ): Promise<ConsumedMediaResult> {
    const room = this.getRoom(callId);
    const transport = room.transports.get(transportId);
    if (
      !transport ||
      transport.userId !== userId ||
      transport.direction !== 'recv' ||
      !transport.connected
    ) {
      throw new Error('Receive transport is not connected');
    }

    if (
      !Array.isArray(rtpCapabilities.codecs) ||
      rtpCapabilities.codecs.length === 0
    ) {
      throw new Error('Cannot consume producer with provided RTP capabilities');
    }

    const producer = room.producers.get(producerId);
    if (!producer || producer.closed) {
      throw new Error('Producer not found');
    }

    this.consumerCounter += 1;
    const consumerId = `consumer-${this.consumerCounter}`;
    room.consumers.set(consumerId, {
      userId,
      transportId,
      producerId,
      paused: true,
      closed: false,
    });

    return Promise.resolve({
      consumerId,
      producerId,
      kind: producer.kind,
      rtpParameters: { codecs: rtpCapabilities.codecs },
    });
  }

  resumeConsumer(
    callId: string,
    userId: string,
    consumerId: string,
  ): Promise<void> {
    const room = this.getRoom(callId);
    const consumer = room.consumers.get(consumerId);
    if (!consumer || consumer.userId !== userId || consumer.closed) {
      throw new Error('Consumer not found');
    }
    consumer.paused = false;
    return Promise.resolve();
  }

  listActiveProducers(
    callId: string,
    excludingUserId?: string,
  ): Promise<ActiveProducerResult[]> {
    const room = this.getRoom(callId);

    return Promise.resolve(
      [...room.producers.entries()]
        .filter(([, producer]) => !producer.closed)
        .map(([producerId, producer]) => ({
          producerId,
          userId: producer.userId,
          kind: producer.kind,
          paused: producer.paused,
        }))
        .filter((producer) =>
          excludingUserId ? producer.userId !== excludingUserId : true,
        ),
    );
  }

  pauseProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    const room = this.getRoom(callId);
    const producer = room.producers.get(producerId);
    if (!producer || producer.userId !== userId || producer.closed) {
      throw new Error('Producer not found');
    }
    producer.paused = true;
    return Promise.resolve();
  }

  resumeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    const room = this.getRoom(callId);
    const producer = room.producers.get(producerId);
    if (!producer || producer.userId !== userId || producer.closed) {
      throw new Error('Producer not found');
    }
    producer.paused = false;
    return Promise.resolve();
  }

  closeProducer(
    callId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    const room = this.getRoom(callId);
    const producer = room.producers.get(producerId);
    if (!producer || producer.userId !== userId || producer.closed) {
      throw new Error('Producer not found');
    }

    producer.closed = true;
    for (const consumer of room.consumers.values()) {
      if (consumer.producerId === producerId) {
        consumer.closed = true;
      }
    }
    return Promise.resolve();
  }

  closeRoom(callId: string): Promise<void> {
    const room = this.rooms.get(callId);
    if (!room) return Promise.resolve();

    for (const transport of room.transports.values()) {
      transport.closed = true;
    }
    for (const producer of room.producers.values()) {
      producer.closed = true;
    }
    for (const consumer of room.consumers.values()) {
      consumer.closed = true;
    }
    this.rooms.delete(callId);
    return Promise.resolve();
  }

  getRoomState(callId: string): RoomState | undefined {
    return this.rooms.get(callId);
  }

  getConsumerState(callId: string, consumerId: string) {
    return this.rooms.get(callId)?.consumers.get(consumerId);
  }

  reset(): void {
    this.rooms.clear();
    this.roomCounter = 0;
    this.transportCounter = 0;
    this.producerCounter = 0;
    this.consumerCounter = 0;
  }

  private createTransport(
    callId: string,
    userId: string,
    direction: 'send',
  ): Promise<CreateSendTransportResult>;
  private createTransport(
    callId: string,
    userId: string,
    direction: 'recv',
  ): Promise<CreateRecvTransportResult>;
  private createTransport(
    callId: string,
    userId: string,
    direction: 'send' | 'recv',
  ): Promise<CreateSendTransportResult | CreateRecvTransportResult> {
    const room = this.getRoom(callId);
    this.transportCounter += 1;
    const transportId = `transport-${this.transportCounter}`;
    room.transports.set(transportId, {
      userId,
      direction,
      connected: false,
      closed: false,
    });

    return Promise.resolve({
      transportId,
      direction,
      iceParameters: { usernameFragment: `${transportId}-ufrag` },
      iceCandidates: [{ foundation: `${transportId}-candidate` }],
      dtlsParameters: {
        fingerprints: [{ algorithm: 'sha-256', value: 'test' }],
      },
    });
  }

  private getRoom(callId: string): RoomState {
    const room = this.rooms.get(callId);
    if (!room) {
      throw new Error('Call room not found');
    }
    return room;
  }
}

describe('Call Service P0 flow (e2e)', () => {
  const callerUser: AuthUser = {
    id: 'caller-user',
    email: 'caller@example.com',
    roles: ['USER'],
  };
  const calleeUser: AuthUser = {
    id: 'callee-user',
    email: 'callee@example.com',
    roles: ['USER'],
  };
  const outsiderUser: AuthUser = {
    id: 'outsider-user',
    email: 'outsider@example.com',
    roles: ['USER'],
  };
  const validRtpCapabilities = {
    codecs: [{ mimeType: 'audio/opus' }, { mimeType: 'video/VP8' }],
    headerExtensions: [{ uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
  };

  let app: INestApplication;
  let moduleRef: TestingModule;
  let gateway: CallGateway;
  let publishCallAnswerOutbox: PublishCallAnswerOutboxUseCase;
  let publishCallTerminalOutbox: PublishCallTerminalOutboxUseCase;
  let redis: FakeRedisClient;
  let eventPublisher: FakeCallEventPublisher;
  let mediaEngine: FakeCallMediaEngine;
  let baseUrl: string;
  const sockets: Socket[] = [];
  const originalReconnectGraceMs = process.env.CALL_RECONNECT_GRACE_MS;
  const originalNoAnswerTimeoutMs = process.env.CALL_NO_ANSWER_TIMEOUT_MS;

  beforeEach(async () => {
    process.env.CALL_RECONNECT_GRACE_MS = '50';
    process.env.CALL_NO_ANSWER_TIMEOUT_MS = '50';
    redis = new FakeRedisClient();
    eventPublisher = new FakeCallEventPublisher();
    mediaEngine = new FakeCallMediaEngine();

    moduleRef = await Test.createTestingModule({
      imports: [CallServiceModule],
    })
      .overrideProvider('REDIS_CLIENT')
      .useValue(redis)
      .overrideProvider('AUTH_SERVICE_RMQ')
      .useValue(
        new FakeAuthClient({
          'caller-token': callerUser,
          'callee-token': calleeUser,
          'outsider-token': outsiderUser,
        }),
      )
      .overrideProvider('CONVERSATION_SERVICE_RMQ')
      .useValue(
        new FakeConversationClient({
          'conv-happy-path': {
            id: 'conv-happy-path',
            participantIds: [callerUser.id, calleeUser.id],
            isGroup: false,
          },
          'conv-active': {
            id: 'conv-active',
            participantIds: [callerUser.id, calleeUser.id],
            isGroup: false,
          },
          'conv-cancel': {
            id: 'conv-cancel',
            participantIds: [callerUser.id, calleeUser.id],
            isGroup: false,
          },
        }),
      )
      .overrideProvider('ICallEventPublisher')
      .useValue(eventPublisher)
      .overrideProvider('ICallMediaEngine')
      .useValue(mediaEngine)
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);

    const httpServer = app.getHttpServer() as {
      address(): AddressInfo | string | null;
    };
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not return a usable address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    gateway = app.get(CallGateway);
    publishCallAnswerOutbox = app.get(PublishCallAnswerOutboxUseCase);
    publishCallTerminalOutbox = app.get(PublishCallTerminalOutboxUseCase);
  });

  afterEach(async () => {
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.connected) {
              socket.once('disconnect', () => resolve());
              socket.disconnect();
              return;
            }
            resolve();
          }),
      ),
    );
    sockets.length = 0;
    await app.close();
    redis.reset();
    eventPublisher.reset();
    mediaEngine.reset();
    process.env.CALL_RECONNECT_GRACE_MS = originalReconnectGraceMs;
    process.env.CALL_NO_ANSWER_TIMEOUT_MS = originalNoAnswerTimeoutMs;
  });

  it('disconnects clients with missing or invalid tokens and joins valid clients to private rooms', async () => {
    const missingTokenClient = createClient();
    const invalidTokenClient = createClient('invalid-token');
    const validClient = createClient('caller-token');

    const missingTokenDisconnect = waitForDisconnect(missingTokenClient);
    const invalidTokenDisconnect = waitForDisconnect(invalidTokenClient);
    const validConnect = waitForConnect(validClient);

    missingTokenClient.connect();
    invalidTokenClient.connect();
    validClient.connect();

    await expect(missingTokenDisconnect).resolves.toBe('io server disconnect');
    await expect(invalidTokenDisconnect).resolves.toBe('io server disconnect');
    await expect(validConnect).resolves.toBeUndefined();

    const socketsInPrivateRoom = await gateway.server
      .in(callerUser.id)
      .fetchSockets();
    expect(socketsInPrivateRoom).toHaveLength(1);
    expect(socketsInPrivateRoom[0]?.id).toBe(validClient.id);
  });

  it('runs the happy-path call lifecycle from initiate to answer', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');

    const callerJoined = onceEvent<{
      callId: string;
      session: { callId: string };
    }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-happy-path',
      targetUserId: calleeUser.id,
      callType: 'VIDEO',
    });

    const [{ callId, session }, incoming] = await Promise.all([
      callerJoined,
      incomingCall,
    ]);

    expect(incoming.callId).toBe(callId);

    const rawSession = await redis.get(`call:${callId}:session`);
    expect(rawSession).not.toBeNull();
    expect(JSON.parse(rawSession as string)).toEqual(
      expect.objectContaining({
        callId,
        conversationId: 'conv-happy-path',
        initiatorId: callerUser.id,
        targetUserId: calleeUser.id,
        status: 'initiated',
      }),
    );

    const callerRejoin = onceEvent(caller, 'call_joined');
    const calleeJoin = onceEvent(callee, 'call_joined');
    const newPeer = onceEvent<{ callId: string; userId: string }>(
      caller,
      'new_peer',
    );

    caller.emit('join_call', { callId: session.callId });
    callee.emit('join_call', { callId: session.callId });

    await Promise.all([callerRejoin, calleeJoin]);
    await expect(newPeer).resolves.toEqual({
      callId,
      userId: calleeUser.id,
    });

    const ringingSession = await redis.get(`call:${callId}:session`);
    expect(JSON.parse(ringingSession as string)).toEqual(
      expect.objectContaining({
        status: 'ringing',
        participantIds: [callerUser.id, calleeUser.id],
      }),
    );

    const answered = onceEvent<{
      callId: string;
      userId: string;
      answerActionId?: string;
    }>(caller, 'call_answered');
    callee.emit('answer_call', { callId });

    await expect(answered).resolves.toEqual(
      expect.objectContaining({
        callId,
        userId: calleeUser.id,
        answerActionId: expect.stringMatching(/^legacy:/),
      }),
    );

    const activeSession = await redis.get(`call:${callId}:session`);
    expect(JSON.parse(activeSession as string)).toEqual(
      expect.objectContaining({
        status: 'active',
      }),
    );
    await publishCallAnswerOutbox.execute();
    expect(eventPublisher.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'call.initiated',
        }),
        expect.objectContaining({
          event: 'call.answered',
        }),
      ]),
    );
  });

  it('atomically tombstones an expired call when an accept reaches the deadline', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');
    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-happy-path',
      targetUserId: calleeUser.id,
      callType: 'VOICE',
    });
    const [{ callId }] = await Promise.all([callerJoined, incomingCall]);

    // Isolate the exact deadline race from the gateway's in-memory fast-path.
    // The durable Redis transition, not a local timer, must decide the result.
    (
      gateway as unknown as {
        clearPendingUnansweredCall: (id: string) => void;
      }
    ).clearPendingUnansweredCall(callId);
    const rawSession = await redis.get(`call:${callId}:session`);
    expect(rawSession).not.toBeNull();
    const expiredSession = JSON.parse(rawSession!);
    expiredSession.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await redis.set(`call:${callId}:session`, JSON.stringify(expiredSession));

    const acceptance = onceEvent<{ callId: string; outcome: string }>(
      callee,
      'incoming_call_acceptance',
    );
    const callerEnded = onceEvent<{ callId: string; reason: string }>(
      caller,
      'call_ended',
    );
    const calleeEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );
    callee.emit('accept_incoming_call', {
      callId,
      actionId: 'native-expired-at-deadline',
    });

    await expect(acceptance).resolves.toEqual(
      expect.objectContaining({ callId, outcome: 'expired' }),
    );
    await expect(callerEnded).resolves.toEqual({ callId, reason: 'no_answer' });
    await expect(calleeEnded).resolves.toEqual({ callId, reason: 'no_answer' });
    await expectTerminalCallResourcesCleared(callId);
    expect(JSON.parse((await redis.get(`call:${callId}:session`))!)).toEqual(
      expect.objectContaining({
        status: 'ended',
        terminalReason: 'no_answer',
        terminalEventPublishedAt: null,
      }),
    );
  });

  it('keeps the legacy join path on the same immediate expiry lifecycle', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');
    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-happy-path',
      targetUserId: calleeUser.id,
      callType: 'VOICE',
    });
    const [{ callId }] = await Promise.all([callerJoined, incomingCall]);

    (
      gateway as unknown as {
        clearPendingUnansweredCall: (id: string) => void;
      }
    ).clearPendingUnansweredCall(callId);
    const rawSession = await redis.get(`call:${callId}:session`);
    expect(rawSession).not.toBeNull();
    const expiredSession = JSON.parse(rawSession!);
    expiredSession.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await redis.set(`call:${callId}:session`, JSON.stringify(expiredSession));

    const expiredException = onceEvent<{ message: string }>(
      callee,
      'exception',
    );
    const callerEnded = onceEvent<{ callId: string; reason: string }>(
      caller,
      'call_ended',
    );
    const calleeEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );
    callee.emit('join_call', { callId });

    await expect(expiredException).resolves.toEqual(
      expect.objectContaining({ message: 'Call has expired' }),
    );
    await expect(callerEnded).resolves.toEqual({ callId, reason: 'no_answer' });
    await expect(calleeEnded).resolves.toEqual({ callId, reason: 'no_answer' });
    await expectTerminalCallResourcesCleared(callId);
  });

  it('rejects a second call acceptance as busy without ending the existing call', async () => {
    const {
      caller,
      callee,
      callId: activeCallId,
    } = await establishActiveCall('VOICE');

    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');
    caller.emit('initiate_call', {
      conversationId: 'conv-active',
      targetUserId: calleeUser.id,
      callType: 'VIDEO',
    });
    const [{ callId: busyCallId }] = await Promise.all([
      callerJoined,
      incomingCall,
    ]);

    const joined = onceEvent(callee, 'call_joined');
    callee.emit('join_call', { callId: busyCallId });
    await joined;

    const acceptance = onceEvent<{
      callId: string;
      outcome: string;
      session?: { status: string; terminalReason?: string };
    }>(callee, 'incoming_call_acceptance');
    const ended = onceEvent<{ callId: string; reason: string }>(
      caller,
      'call_ended',
    );
    callee.emit('accept_incoming_call', {
      callId: busyCallId,
      actionId: 'busy-action-1',
    });

    await expect(acceptance).resolves.toEqual(
      expect.objectContaining({
        callId: busyCallId,
        outcome: 'busy',
        session: expect.objectContaining({
          status: 'ended',
          terminalReason: 'busy',
        }),
      }),
    );
    await expect(ended).resolves.toEqual({
      callId: busyCallId,
      reason: 'busy',
    });

    const [busySession, activeSession] = await Promise.all([
      redis.get(`call:${busyCallId}:session`),
      redis.get(`call:${activeCallId}:session`),
    ]);
    expect(JSON.parse(busySession!)).toEqual(
      expect.objectContaining({
        status: 'ended',
        terminalReason: 'busy',
      }),
    );
    expect(JSON.parse(activeSession!)).toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('releases the active-user claim when a call ends so a later call can be accepted', async () => {
    const {
      caller,
      callee,
      callId: firstCallId,
    } = await establishActiveCall('VOICE');
    const firstCallEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );
    caller.emit('leave_call', { callId: firstCallId, reason: 'ended' });
    await expect(firstCallEnded).resolves.toEqual({
      callId: firstCallId,
      reason: 'ended',
    });

    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');
    caller.emit('initiate_call', {
      conversationId: 'conv-active',
      targetUserId: calleeUser.id,
      callType: 'VIDEO',
    });
    const [{ callId: nextCallId }] = await Promise.all([
      callerJoined,
      incomingCall,
    ]);
    const calleeJoined = onceEvent(callee, 'call_joined');
    callee.emit('join_call', { callId: nextCallId });
    await calleeJoined;

    const acceptance = onceEvent<{ callId: string; outcome: string }>(
      callee,
      'incoming_call_acceptance',
    );
    callee.emit('accept_incoming_call', {
      callId: nextCallId,
      actionId: 'next-call-action',
    });
    await expect(acceptance).resolves.toEqual(
      expect.objectContaining({
        callId: nextCallId,
        outcome: 'accepted',
      }),
    );
  });

  it('rejects forged target users before creating a call session', async () => {
    const caller = await connectClient('caller-token');
    const exception = onceEvent<{ status: string; message: string }>(
      caller,
      'exception',
    );

    caller.emit('initiate_call', {
      conversationId: 'conv-happy-path',
      targetUserId: 'forged-user',
      callType: 'VIDEO',
    });

    await expect(exception).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
      }),
    );
    expect(eventPublisher.events).toEqual([]);
  });

  it('runs the media flow from transport creation to consumer resume', async () => {
    const { caller, callee, callId } = await establishActiveCall();

    const callerSendTransport = await createAndConnectTransport(
      caller,
      callId,
      'send',
    );
    const calleeRecvTransport = await createAndConnectTransport(
      callee,
      callId,
      'recv',
    );

    const calleeProducerNotice = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      kind: 'audio' | 'video';
    }>(callee, 'new_producer');

    caller.emit('produce', {
      callId,
      transportId: callerSendTransport.transportId,
      kind: 'audio',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });

    const producerNotice = await calleeProducerNotice;
    expect(producerNotice.callId).toBe(callId);
    expect(producerNotice.userId).toBe(callerUser.id);
    expect(producerNotice.kind).toBe('audio');

    const consumerCreated = onceEvent<{
      callId: string;
      consumerId: string;
      producerId: string;
    }>(callee, 'consumer_created');

    callee.emit('consume', {
      callId,
      transportId: calleeRecvTransport.transportId,
      producerId: producerNotice.producerId,
      rtpCapabilities: validRtpCapabilities,
    });

    const consumer = await consumerCreated;
    expect(consumer.producerId).toBe(producerNotice.producerId);
    expect(
      mediaEngine.getConsumerState(callId, consumer.consumerId)?.paused,
    ).toBe(true);

    const consumerResumed = onceEvent<{ callId: string; consumerId: string }>(
      callee,
      'consumer_resumed',
    );
    callee.emit('resume_consumer', {
      callId,
      consumerId: consumer.consumerId,
    });

    await expect(consumerResumed).resolves.toEqual({
      callId,
      consumerId: consumer.consumerId,
    });
    expect(
      mediaEngine.getConsumerState(callId, consumer.consumerId)?.paused,
    ).toBe(false);
  });

  it('cancels a call when the caller leaves before answer and clears live media state', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');

    const callerJoined = onceEvent<{
      callId: string;
      noAnswerTimeoutMs: number;
    }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-cancel',
      targetUserId: calleeUser.id,
      callType: 'VOICE',
    });

    const [{ callId, noAnswerTimeoutMs }, incoming] = await Promise.all([
      callerJoined,
      incomingCall,
    ]);
    expect(incoming.callId).toBe(callId);
    expect(noAnswerTimeoutMs).toBe(50);

    const callEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );
    caller.emit('leave_call', { callId });

    await expect(callEnded).resolves.toEqual({
      callId,
      reason: 'cancelled',
    });

    await expectTerminalCallResourcesCleared(callId);
    expect(
      eventPublisher.events.find(
        (entry) =>
          entry.event === 'call.ended' &&
          entry.payload.callId === callId &&
          entry.payload.reason === 'cancelled',
      ),
    ).toBeDefined();
  });

  it('retries a cancelled call notification from the durable terminal outbox', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');
    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-cancel',
      targetUserId: calleeUser.id,
      callType: 'VOICE',
    });
    const [{ callId }] = await Promise.all([callerJoined, incomingCall]);

    eventPublisher.reset();
    eventPublisher.failNextPublish();
    const callEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );
    caller.emit('leave_call', { callId });
    await expect(callEnded).resolves.toEqual({ callId, reason: 'cancelled' });

    await expect(publishCallTerminalOutbox.execute()).resolves.toBe(1);
    expect(eventPublisher.events).toEqual([
      expect.objectContaining({
        event: 'call.ended',
        payload: expect.objectContaining({
          callId,
          reason: 'cancelled',
          userId: callerUser.id,
        }),
      }),
    ]);
    await expect(publishCallTerminalOutbox.execute()).resolves.toBe(0);
  });

  // VIDEO_CALL_1TO1_E2E
  it('auto-ends unanswered video calls after the backend no-answer timeout', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');

    const callerJoined = onceEvent<{
      callId: string;
      noAnswerTimeoutMs: number;
    }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-cancel',
      targetUserId: calleeUser.id,
      callType: 'VIDEO',
    });

    const [{ callId, noAnswerTimeoutMs }, incoming] = await Promise.all([
      callerJoined,
      incomingCall,
    ]);
    expect(incoming.callId).toBe(callId);
    expect(noAnswerTimeoutMs).toBe(50);

    const callerEnded = onceEvent<{ callId: string; reason: string }>(
      caller,
      'call_ended',
    );
    const calleeEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );

    await expect(callerEnded).resolves.toEqual({ callId, reason: 'no_answer' });
    await expect(calleeEnded).resolves.toEqual({ callId, reason: 'no_answer' });
    await expectTerminalCallResourcesCleared(callId);
  });

  it('switches VOICE to VIDEO and back on the same active call while enforcing media kind', async () => {
    const { caller, callee, callId } = await establishActiveCall('VOICE');
    const callerSendTransport = await createAndConnectTransport(
      caller,
      callId,
      'send',
    );
    const calleeRecvTransport = await createAndConnectTransport(
      callee,
      callId,
      'recv',
    );

    const audioNoticePromise = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      kind: 'audio' | 'video';
    }>(callee, 'new_producer');
    caller.emit('produce', {
      callId,
      transportId: callerSendTransport.transportId,
      kind: 'audio',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });
    const audioNotice = await audioNoticePromise;
    expect(audioNotice.kind).toBe('audio');

    const forbiddenVideo = onceEvent<{ status: string; message: string }>(
      caller,
      'exception',
    );
    caller.emit('produce', {
      callId,
      transportId: callerSendTransport.transportId,
      kind: 'video',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });
    await expect(forbiddenVideo).resolves.toEqual(
      expect.objectContaining({ status: 'error' }),
    );

    const callerUpgraded = onceEvent<{
      callId: string;
      callType: string;
      changedByUserId: string;
    }>(caller, 'call_type_changed');
    const calleeUpgraded = onceEvent<{
      callId: string;
      callType: string;
      changedByUserId: string;
    }>(callee, 'call_type_changed');
    caller.emit('set_call_type', { callId, callType: 'VIDEO' });

    await expect(callerUpgraded).resolves.toEqual({
      callId,
      callType: 'VIDEO',
      changedByUserId: callerUser.id,
    });
    await expect(calleeUpgraded).resolves.toEqual({
      callId,
      callType: 'VIDEO',
      changedByUserId: callerUser.id,
    });

    const videoNoticePromise = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      kind: 'audio' | 'video';
    }>(callee, 'new_producer');
    caller.emit('produce', {
      callId,
      transportId: callerSendTransport.transportId,
      kind: 'video',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });
    const videoNotice = await videoNoticePromise;
    expect(videoNotice.kind).toBe('video');

    const consumerCreated = onceEvent<{
      callId: string;
      consumerId: string;
      producerId: string;
      kind: 'audio' | 'video';
    }>(callee, 'consumer_created');
    callee.emit('consume', {
      callId,
      transportId: calleeRecvTransport.transportId,
      producerId: videoNotice.producerId,
      rtpCapabilities: validRtpCapabilities,
    });
    await expect(consumerCreated).resolves.toEqual(
      expect.objectContaining({
        callId,
        producerId: videoNotice.producerId,
        kind: 'video',
      }),
    );

    const producerClosed = onceEvent<{
      callId: string;
      producerId: string;
      kind: string;
    }>(caller, 'producer_closed');
    const callerDowngraded = onceEvent<{ callId: string; callType: string }>(
      caller,
      'call_type_changed',
    );
    const calleeDowngraded = onceEvent<{ callId: string; callType: string }>(
      callee,
      'call_type_changed',
    );
    caller.emit('set_call_type', { callId, callType: 'VOICE' });

    await expect(producerClosed).resolves.toEqual({
      callId,
      producerId: videoNotice.producerId,
      kind: 'video',
    });
    await expect(callerDowngraded).resolves.toEqual(
      expect.objectContaining({ callId, callType: 'VOICE' }),
    );
    await expect(calleeDowngraded).resolves.toEqual(
      expect.objectContaining({ callId, callType: 'VOICE' }),
    );

    const rawSession = await redis.get(`call:${callId}:session`);
    expect(JSON.parse(rawSession as string)).toEqual(
      expect.objectContaining({ callId, callType: 'VOICE', status: 'active' }),
    );
    expect(
      mediaEngine.getRoomState(callId)?.producers.get(videoNotice.producerId)
        ?.closed,
    ).toBe(true);
    expect(
      mediaEngine.getRoomState(callId)?.producers.get(audioNotice.producerId)
        ?.closed,
    ).toBe(false);
  });

  it('rejoin advertises both active audio and video producers for a VIDEO call', async () => {
    const { caller, callee, callId } = await establishActiveCall('VIDEO');
    const calleeSendTransport = await createAndConnectTransport(
      callee,
      callId,
      'send',
    );

    const audioNoticePromise = onceEvent<{
      producerId: string;
      kind: 'audio' | 'video';
    }>(caller, 'new_producer');
    callee.emit('produce', {
      callId,
      transportId: calleeSendTransport.transportId,
      kind: 'audio',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });
    const audioNotice = await audioNoticePromise;

    const videoNoticePromise = onceEvent<{
      producerId: string;
      kind: 'audio' | 'video';
    }>(caller, 'new_producer');
    callee.emit('produce', {
      callId,
      transportId: calleeSendTransport.transportId,
      kind: 'video',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });
    const videoNotice = await videoNoticePromise;

    const peerReconnecting = onceEvent(callee, 'peer_reconnecting');
    const callerDisconnected = waitForDisconnect(caller);
    caller.disconnect();
    await callerDisconnected;
    await peerReconnecting;

    await waitForStoredParticipant(
      callId,
      callerUser.id,
      (participant) => participant?.isConnected === false,
    );

    const callerReconnected = await connectClient('caller-token');
    const rejoined = onceEvent<{
      callId: string;
      session: { status: string; callType: 'VOICE' | 'VIDEO' };
      activeProducers?: Array<{
        userId: string;
        producerId: string;
        kind: 'audio' | 'video';
      }>;
    }>(callerReconnected, 'call_rejoined');
    callerReconnected.emit('rejoin_call', { callId });

    const payload = await rejoined;
    expect(payload.callId).toBe(callId);
    expect(payload.session).toEqual(
      expect.objectContaining({ status: 'active', callType: 'VIDEO' }),
    );
    expect(payload.activeProducers).toEqual(
      expect.arrayContaining([
        {
          userId: calleeUser.id,
          producerId: audioNotice.producerId,
          kind: 'audio',
          paused: false,
        },
        {
          userId: calleeUser.id,
          producerId: videoNotice.producerId,
          kind: 'video',
          paused: false,
        },
      ]),
    );
  });

  it('broadcasts camera off/on without replacing the video producer', async () => {
    const { caller, callee, callId } = await establishActiveCall('VIDEO');
    const callerSendTransport = await createAndConnectTransport(
      caller,
      callId,
      'send',
    );

    const videoNoticePromise = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      kind: 'audio' | 'video';
    }>(callee, 'new_producer');
    caller.emit('produce', {
      callId,
      transportId: callerSendTransport.transportId,
      kind: 'video',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });
    const videoNotice = await videoNoticePromise;

    const cameraOff = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      enabled: boolean;
    }>(callee, 'video_state_changed');
    caller.emit('set_video_enabled', {
      callId,
      producerId: videoNotice.producerId,
      enabled: false,
    });
    await expect(cameraOff).resolves.toEqual({
      callId,
      userId: callerUser.id,
      producerId: videoNotice.producerId,
      enabled: false,
    });
    expect(
      mediaEngine.getRoomState(callId)?.producers.get(videoNotice.producerId)
        ?.paused,
    ).toBe(true);

    const cameraOn = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      enabled: boolean;
    }>(callee, 'video_state_changed');
    caller.emit('set_video_enabled', {
      callId,
      producerId: videoNotice.producerId,
      enabled: true,
    });
    await expect(cameraOn).resolves.toEqual({
      callId,
      userId: callerUser.id,
      producerId: videoNotice.producerId,
      enabled: true,
    });
    expect(
      mediaEngine.getRoomState(callId)?.producers.get(videoNotice.producerId)
        ?.paused,
    ).toBe(false);
  });

  it('auto-ends unanswered voice calls after the backend no-answer timeout', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');

    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-cancel',
      targetUserId: calleeUser.id,
      callType: 'VOICE',
    });

    const [{ callId }, incoming] = await Promise.all([
      callerJoined,
      incomingCall,
    ]);
    expect(incoming.callId).toBe(callId);

    const callerEnded = onceEvent<{ callId: string; reason: string }>(
      caller,
      'call_ended',
    );
    const calleeEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );

    await expect(callerEnded).resolves.toEqual({
      callId,
      reason: 'no_answer',
    });
    await expect(calleeEnded).resolves.toEqual({
      callId,
      reason: 'no_answer',
    });

    await expectTerminalCallResourcesCleared(callId);
    expect(
      eventPublisher.events.find(
        (entry) =>
          entry.event === 'call.ended' &&
          entry.payload.callId === callId &&
          entry.payload.reason === 'no_answer',
      ),
    ).toBeDefined();
  });

  it('does not let answer_call bypass join_call before the no-answer timeout', async () => {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');

    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-cancel',
      targetUserId: calleeUser.id,
      callType: 'VOICE',
    });

    const [{ callId }, incoming] = await Promise.all([
      callerJoined,
      incomingCall,
    ]);
    expect(incoming.callId).toBe(callId);

    const answerException = onceEvent<{ status: string; message: string }>(
      callee,
      'exception',
    );
    const callerEnded = onceEvent<{ callId: string; reason: string }>(
      caller,
      'call_ended',
    );
    const calleeEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );

    callee.emit('answer_call', { callId });

    await expect(answerException).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        message: 'Call cannot be answered in its current state',
      }),
    );
    await expect(callerEnded).resolves.toEqual({
      callId,
      reason: 'no_answer',
    });
    await expect(calleeEnded).resolves.toEqual({
      callId,
      reason: 'no_answer',
    });

    await expectTerminalCallResourcesCleared(callId);
  });

  it('fails fast when a ringing call disconnects before answer', async () => {
    const { caller, callee, callId } = await establishRingingCall();

    const callEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );

    const callerDisconnected = waitForDisconnect(caller);
    caller.disconnect();
    await callerDisconnected;

    await expect(callEnded).resolves.toEqual({
      callId,
      reason: 'disconnected',
    });
    await expectTerminalCallResourcesCleared(callId);
  });

  it('rejects rejoin attempts for calls that are not active', async () => {
    const { caller, callId } = await establishRingingCall();

    const exception = onceEvent<{ status: string; message: string }>(
      caller,
      'exception',
    );
    caller.emit('rejoin_call', { callId });

    await expect(exception).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
      }),
    );
  });

  it('ends an active call after the reconnect grace window expires', async () => {
    const { caller, callee, callId } = await establishActiveCall();

    const callEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );

    const callerDisconnected = waitForDisconnect(caller);
    caller.disconnect();
    await callerDisconnected;

    expect(await redis.get(`call:${callId}:session`)).not.toBeNull();
    const disconnectedParticipant = await waitForStoredParticipant(
      callId,
      callerUser.id,
      (participant) =>
        participant?.isConnected === false &&
        typeof participant.reconnectDeadlineAt === 'string',
    );
    expect(disconnectedParticipant?.isConnected).toBe(false);
    expect(disconnectedParticipant?.reconnectDeadlineAt).toBeDefined();

    await expect(callEnded).resolves.toEqual({
      callId,
      reason: 'disconnected',
    });

    await expectTerminalCallResourcesCleared(callId);
    expect(
      eventPublisher.events.find(
        (entry) =>
          entry.event === 'call.ended' &&
          entry.payload.callId === callId &&
          entry.payload.reason === 'disconnected',
      ),
    ).toBeDefined();
  });

  it('rejoins an active call within the reconnect grace window', async () => {
    const { caller, callee, callId } = await establishActiveCall();
    const calleeSendTransport = await createAndConnectTransport(
      callee,
      callId,
      'send',
    );

    const initialProducerNotice = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      kind: 'audio' | 'video';
    }>(caller, 'new_producer');
    callee.emit('produce', {
      callId,
      transportId: calleeSendTransport.transportId,
      kind: 'audio',
      rtpParameters: { codecs: validRtpCapabilities.codecs },
    });
    const producedByCallee = await initialProducerNotice;

    const peerReconnecting = onceEvent<{
      callId: string;
      userId: string;
      reconnectDeadlineAt: string;
    }>(callee, 'peer_reconnecting');
    const unexpectedCallEnded = waitForOptionalEvent(callee, 'call_ended', 120);
    const callerDisconnected = waitForDisconnect(caller);
    caller.disconnect();
    await callerDisconnected;

    await expect(peerReconnecting).resolves.toEqual({
      callId,
      userId: callerUser.id,
      reconnectDeadlineAt: expect.any(String),
    });

    await waitForStoredParticipant(
      callId,
      callerUser.id,
      (participant) =>
        participant?.isConnected === false &&
        typeof participant.reconnectDeadlineAt === 'string',
    );

    const callerReconnected = await connectClient('caller-token');
    const callRejoined = onceEvent<{
      callId: string;
      session: { status: string };
    }>(callerReconnected, 'call_rejoined');
    const replayedProducer = onceEvent<{
      callId: string;
      userId: string;
      producerId: string;
      kind: 'audio' | 'video';
    }>(callerReconnected, 'new_producer');
    const peerReconnected = onceEvent<{ callId: string; userId: string }>(
      callee,
      'peer_reconnected',
    );
    callerReconnected.emit('rejoin_call', { callId });

    await expect(callRejoined).resolves.toEqual(
      expect.objectContaining({
        callId,
        session: expect.objectContaining({
          status: 'active',
        }),
      }),
    );
    await expect(replayedProducer).resolves.toEqual({
      callId,
      userId: calleeUser.id,
      producerId: producedByCallee.producerId,
      kind: 'audio',
      paused: false,
    });
    await expect(peerReconnected).resolves.toEqual({
      callId,
      userId: callerUser.id,
    });
    await expect(unexpectedCallEnded).resolves.toBeNull();

    const participantAfterRejoin = await waitForStoredParticipant(
      callId,
      callerUser.id,
      (participant) =>
        participant?.isConnected === true &&
        participant.socketIds?.length === 1 &&
        participant.reconnectDeadlineAt === undefined,
    );
    expect(participantAfterRejoin?.isConnected).toBe(true);
    expect(participantAfterRejoin?.socketIds).toHaveLength(1);
    expect(participantAfterRejoin?.reconnectDeadlineAt).toBeUndefined();
    expect(await redis.get(`call:${callId}:session`)).not.toBeNull();
  });

  it('rejects rejoin attempts after the reconnect grace window has already expired', async () => {
    const { caller, callee, callId } = await establishActiveCall();

    const callEnded = onceEvent<{ callId: string; reason: string }>(
      callee,
      'call_ended',
    );
    const callerDisconnected = waitForDisconnect(caller);
    caller.disconnect();
    await callerDisconnected;
    await callEnded;

    const callerReconnected = await connectClient('caller-token');
    const exception = onceEvent<{ status: string; message: string }>(
      callerReconnected,
      'exception',
    );
    callerReconnected.emit('rejoin_call', { callId });

    await expect(exception).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
      }),
    );
  });

  it('rejects rejoin attempts from users outside the active call', async () => {
    const { callId } = await establishActiveCall();
    const outsider = await connectClient('outsider-token');

    const exception = onceEvent<{ status: string; message: string }>(
      outsider,
      'exception',
    );
    outsider.emit('rejoin_call', { callId });

    await expect(exception).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
      }),
    );
  });

  it('keeps the call active when one socket disconnects but the same user still has another socket in the call', async () => {
    const { caller, callee, callId } = await establishActiveCall();
    const callerSecondSocket = await connectClient('caller-token');

    const secondSocketJoined = onceEvent(callerSecondSocket, 'call_joined');
    callerSecondSocket.emit('join_call', { callId });
    await secondSocketJoined;

    const participantBeforeDisconnect = await getStoredParticipant(
      callId,
      callerUser.id,
    );
    expect(participantBeforeDisconnect?.socketIds).toHaveLength(2);

    const unexpectedCallEnded = waitForOptionalEvent(callee, 'call_ended', 300);
    const callerDisconnected = waitForDisconnect(caller);
    caller.disconnect();
    await callerDisconnected;

    await expect(unexpectedCallEnded).resolves.toBeNull();
    expect(await redis.get(`call:${callId}:session`)).not.toBeNull();

    const participantAfterDisconnect = await waitForStoredParticipant(
      callId,
      callerUser.id,
      (participant) =>
        participant?.socketIds?.length === 1 &&
        participant.isConnected === true,
    );
    expect(participantAfterDisconnect?.socketIds).toHaveLength(1);
    expect(participantAfterDisconnect?.isConnected).toBe(true);
  });

  async function establishActiveCall(callType: 'VOICE' | 'VIDEO' = 'VIDEO') {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');

    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-active',
      targetUserId: calleeUser.id,
      callType,
    });

    const [{ callId }] = await Promise.all([callerJoined, incomingCall]);

    const callerRejoin = onceEvent(caller, 'call_joined');
    const calleeJoin = onceEvent(callee, 'call_joined');
    caller.emit('join_call', { callId });
    callee.emit('join_call', { callId });
    await Promise.all([callerRejoin, calleeJoin]);

    const callAnswered = onceEvent<{ callId: string; userId: string }>(
      caller,
      'call_answered',
    );
    callee.emit('answer_call', { callId });
    await callAnswered;

    return { caller, callee, callId };
  }

  async function establishRingingCall() {
    const caller = await connectClient('caller-token');
    const callee = await connectClient('callee-token');

    const callerJoined = onceEvent<{ callId: string }>(caller, 'call_joined');
    const incomingCall = onceEvent<{ callId: string }>(callee, 'incoming_call');

    caller.emit('initiate_call', {
      conversationId: 'conv-active',
      targetUserId: calleeUser.id,
      callType: 'VIDEO',
    });

    const [{ callId }] = await Promise.all([callerJoined, incomingCall]);

    const callerRejoin = onceEvent(caller, 'call_joined');
    const calleeJoin = onceEvent(callee, 'call_joined');
    caller.emit('join_call', { callId });
    callee.emit('join_call', { callId });
    await Promise.all([callerRejoin, calleeJoin]);

    return { caller, callee, callId };
  }

  async function createAndConnectTransport(
    client: Socket,
    callId: string,
    direction: 'send' | 'recv',
  ) {
    const transportCreated = onceEvent<{
      callId: string;
      transportId: string;
      dtlsParameters: Record<string, unknown>;
    }>(client, 'transport_created');

    client.emit('create_transport', { callId, direction });
    const transport = await transportCreated;

    const transportConnected = onceEvent<{
      callId: string;
      transportId: string;
    }>(client, 'transport_connected');
    client.emit('connect_transport', {
      callId,
      transportId: transport.transportId,
      dtlsParameters: transport.dtlsParameters,
    });

    await expect(transportConnected).resolves.toEqual({
      callId,
      transportId: transport.transportId,
    });

    return transport;
  }

  async function expectTerminalCallResourcesCleared(callId: string) {
    const rawSession = await redis.get(`call:${callId}:session`);
    expect(rawSession).not.toBeNull();
    expect(JSON.parse(rawSession!)).toEqual(
      expect.objectContaining({
        callId,
        status: expect.stringMatching(/^(cancelled|ended|rejected)$/),
        terminalReason: expect.any(String),
        endedAt: expect.any(String),
      }),
    );
    expect(await redis.hgetall(`call:${callId}:participants`)).toEqual({});
    expect(await redis.smembers(`call:${callId}:transport-index`)).toEqual([]);
    expect(await redis.smembers(`call:${callId}:producer-index`)).toEqual([]);
    expect(mediaEngine.getRoomState(callId)).toBeUndefined();
  }

  async function getStoredParticipant(callId: string, userId: string) {
    const raw = await redis.hget(`call:${callId}:participants`, userId);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as {
      userId: string;
      socketIds?: string[];
      isConnected?: boolean;
      reconnectDeadlineAt?: string;
    };
  }

  async function waitForStoredParticipant(
    callId: string,
    userId: string,
    predicate: (
      participant: Awaited<ReturnType<typeof getStoredParticipant>>,
    ) => boolean,
    timeoutMs = 500,
  ) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const participant = await getStoredParticipant(callId, userId);
      if (predicate(participant)) {
        return participant;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return getStoredParticipant(callId, userId);
  }

  function createClient(token?: string): Socket {
    const socket = io(`${baseUrl}/call`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      ...(token ? { auth: { token } } : {}),
    });
    sockets.push(socket);
    return socket;
  }

  async function connectClient(token: string): Promise<Socket> {
    const socket = createClient(token);
    const connected = waitForConnect(socket);
    socket.connect();
    await connected;
    return socket;
  }

  function waitForConnect(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for socket connect'));
      }, SOCKET_EVENT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('connect_error', onConnectError);
      };

      const onConnect = () => {
        cleanup();
        resolve();
      };

      const onConnectError = (error: Error) => {
        cleanup();
        reject(error);
      };

      socket.once('connect', onConnect);
      socket.once('connect_error', onConnectError);
    });
  }

  function waitForDisconnect(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for socket disconnect'));
      }, SOCKET_EVENT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('disconnect', onDisconnect);
        socket.off('connect_error', onConnectError);
      };

      const onDisconnect = (reason: string) => {
        cleanup();
        resolve(reason);
      };

      const onConnectError = (error: Error) => {
        cleanup();
        resolve(`connect_error:${error.message}`);
      };

      socket.once('disconnect', onDisconnect);
      socket.once('connect_error', onConnectError);
    });
  }

  function onceEvent<T>(socket: Socket, event: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${event}`));
      }, SOCKET_EVENT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off(event, onEvent);
      };

      const onEvent = (payload: T) => {
        cleanup();
        resolve(payload);
      };

      socket.once(event, onEvent);
    });
  }

  function waitForOptionalEvent<T>(
    socket: Socket,
    event: string,
    timeoutMs: number,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off(event, onEvent);
      };

      const onEvent = (payload: T) => {
        cleanup();
        resolve(payload);
      };

      socket.once(event, onEvent);
    });
  }
});
