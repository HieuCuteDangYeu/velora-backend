import { ForbiddenException } from '@nestjs/common';
import { ChangeCallTypeUseCase } from '../../../src/application/use-cases/change-call-type.use-case';
import { ProduceUseCase } from '../../../src/application/use-cases/produce.use-case';
import { CallSession } from '../../../src/domain/entities/call-session.entity';
import type { ICallMediaEngine } from '../../../src/domain/interfaces/call-media.engine.interface';
import type { ICallSessionRepository } from '../../../src/domain/interfaces/call-session.repository.interface';

describe('1:1 video call use cases', () => {
  const callerId = 'caller';
  const calleeId = 'callee';
  const callId = 'call-video';

  const makeSession = (callType: 'VOICE' | 'VIDEO') =>
    new CallSession({
      callId,
      conversationId: 'conversation',
      initiatorId: callerId,
      targetUserId: calleeId,
      callType,
      status: 'active',
      participantIds: [callerId, calleeId],
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    });

  const makeRepository = (session: CallSession) => {
    const save = jest.fn(async (next: CallSession) => next);
    const repository = {
      save,
      findByCallId: jest.fn(async () => session),
      delete: jest.fn(async () => undefined),
    } as unknown as ICallSessionRepository;
    return { repository, save };
  };

  const makeMediaEngine = () => {
    const produce = jest.fn(async () => ({ producerId: 'producer-new' }));
    const listActiveProducers = jest.fn(async () => [
      { producerId: 'audio-caller', userId: callerId, kind: 'audio' as const },
      { producerId: 'video-caller', userId: callerId, kind: 'video' as const },
      { producerId: 'audio-callee', userId: calleeId, kind: 'audio' as const },
      { producerId: 'video-callee', userId: calleeId, kind: 'video' as const },
    ]);
    const closeProducer = jest.fn(async () => undefined);
    const engine = {
      produce,
      listActiveProducers,
      closeProducer,
    } as unknown as ICallMediaEngine;
    return { engine, produce, listActiveProducers, closeProducer };
  };

  it('upgrades an active voice call to video without replacing audio media', async () => {
    const session = makeSession('VOICE');
    const { repository, save } = makeRepository(session);
    const { engine, closeProducer } = makeMediaEngine();
    const useCase = new ChangeCallTypeUseCase(repository, engine);

    const result = await useCase.execute(callId, callerId, 'VIDEO');

    expect(result).toEqual({
      callId,
      callType: 'VIDEO',
      changedByUserId: callerId,
      closedVideoProducerIds: [],
    });
    expect(session.callType).toBe('VIDEO');
    expect(closeProducer).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(session);
  });

  it('downgrades video to voice by closing only video producers', async () => {
    const session = makeSession('VIDEO');
    const { repository } = makeRepository(session);
    const { engine, closeProducer } = makeMediaEngine();
    const useCase = new ChangeCallTypeUseCase(repository, engine);

    const result = await useCase.execute(callId, callerId, 'VOICE');

    expect(result.closedVideoProducerIds).toEqual([
      'video-caller',
      'video-callee',
    ]);
    expect(closeProducer).toHaveBeenCalledTimes(2);
    expect(closeProducer).toHaveBeenNthCalledWith(
      1,
      callId,
      callerId,
      'video-caller',
    );
    expect(closeProducer).toHaveBeenNthCalledWith(
      2,
      callId,
      calleeId,
      'video-callee',
    );
    expect(session.callType).toBe('VOICE');
  });

  it('does not allow a non-participant to change call type', async () => {
    const session = makeSession('VOICE');
    const { repository } = makeRepository(session);
    const { engine } = makeMediaEngine();
    const useCase = new ChangeCallTypeUseCase(repository, engine);

    await expect(
      useCase.execute(callId, 'intruder', 'VIDEO'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects video production while the session is VOICE', async () => {
    const session = makeSession('VOICE');
    const { repository } = makeRepository(session);
    const { engine, produce } = makeMediaEngine();
    const useCase = new ProduceUseCase(engine, repository);

    await expect(
      useCase.execute(callId, callerId, 'transport', 'video', { codecs: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(produce).not.toHaveBeenCalled();
  });

  it('allows video production after the session becomes VIDEO', async () => {
    const session = makeSession('VIDEO');
    const { repository } = makeRepository(session);
    const { engine, produce } = makeMediaEngine();
    const useCase = new ProduceUseCase(engine, repository);

    await expect(
      useCase.execute(callId, callerId, 'transport', 'video', { codecs: [] }),
    ).resolves.toEqual({ producerId: 'producer-new' });
    expect(produce).toHaveBeenCalledWith(
      callId,
      callerId,
      'transport',
      'video',
      { codecs: [] },
      undefined,
    );
  });
});
