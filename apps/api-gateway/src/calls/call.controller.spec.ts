import { GUARDS_METADATA } from '@nestjs/common/constants';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { Role, ROLES_KEY } from '@gateway/auth/decorators/roles.decorator';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import { CallController } from './call.controller';

describe('CallController recent telemetry', () => {
  it('requires ADMIN and forwards the existing filters to monitoring', async () => {
    const monitoringClient = {
      send: jest.fn().mockReturnValue(of([{ callId: 'call-1' }])),
    };
    const controller = new CallController(
      {} as never,
      monitoringClient as never,
      {} as never,
    );
    const request = {
      query: {
        from: '2026-07-10T00:00:00.000Z',
        to: '2026-07-10T23:59:59.999Z',
        platform: 'ios',
      },
    } as never;

    await expect(controller.recentTelemetryCalls(request)).resolves.toEqual([
      { callId: 'call-1' },
    ]);
    expect(monitoringClient.send).toHaveBeenCalledWith(
      'call.telemetry.recent',
      request.query,
    );
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        CallController.prototype.recentTelemetryCalls,
      ),
    ).toEqual([Role.ADMIN]);
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        CallController.prototype.recentTelemetryCalls,
      ),
    ).toContain(RolesGuard);
  });
});

describe('CallController group state privacy', () => {
  it('scopes active group lookup to the authenticated user', async () => {
    const callClient = {
      send: jest.fn().mockReturnValue(of({ call: null })),
    };
    const controller = new CallController(
      callClient as never,
      {} as never,
      {} as never,
    );
    await expect(
      controller.getActiveGroupByConversation('conv-1', {
        user: { id: 'member' },
      } as never),
    ).resolves.toEqual({ call: null });
    expect(callClient.send).toHaveBeenCalledWith(
      'call.get_active_group_by_conversation',
      { conversationId: 'conv-1', userId: 'member' },
    );
  });

  it('does not forward call metadata to a removed group member', async () => {
    const callClient = {
      send: jest.fn().mockReturnValue(of({ found: true, authorized: false })),
    };
    const controller = new CallController(
      callClient as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.getCallState('call-1', {
        user: { id: 'former-member' },
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(callClient.send).toHaveBeenCalledWith('call.get_state', {
      callId: 'call-1',
      userId: 'former-member',
    });
  });
});

describe('CallController call history', () => {
  const request = { user: { id: 'me' } } as never;
  const item = {
    callId: 'call-1',
    conversationId: 'conversation-1',
    callType: 'VOICE',
    isGroupCall: false,
    initiatorId: 'friend',
    outcome: 'MISSED',
    role: 'CALLEE',
    result: 'MISSED',
    startedAt: '2026-10-22T10:00:00.000Z',
    endedAt: '2026-10-22T10:00:30.000Z',
    peerUserIds: ['friend', 'gone'],
  };

  it('asks call-service for the signed-in user and adds peer profiles', async () => {
    const callClient = {
      send: jest
        .fn()
        .mockReturnValue(of({ items: [item], nextCursor: 'next' })),
    };
    const userClient = {
      send: jest.fn().mockReturnValue(
        of([
          {
            id: 'friend',
            fullName: 'Friend',
            username: 'friend',
            picture: null,
            isVerified: false,
          },
        ]),
      ),
    };
    const controller = new CallController(
      callClient as never,
      {} as never,
      userClient as never,
    );

    const page = await controller.getHistory(request, 'cursor-1', '20');

    expect(callClient.send).toHaveBeenCalledWith('call.get_history', {
      userId: 'me',
      cursor: 'cursor-1',
      limit: 20,
    });
    expect(userClient.send).toHaveBeenCalledWith('user.find_public_by_ids', [
      'friend',
      'gone',
    ]);
    expect(page.nextCursor).toBe('next');
    expect(page.items[0].peers).toEqual([
      expect.objectContaining({ id: 'friend', fullName: 'Friend' }),
      { id: 'gone', fullName: null, username: null, picture: null },
    ]);
  });

  it('still returns history when profiles cannot be loaded', async () => {
    const controller = new CallController(
      {
        send: jest
          .fn()
          .mockReturnValue(of({ items: [item], nextCursor: null })),
      } as never,
      {} as never,
      {
        send: jest.fn().mockReturnValue(throwError(() => new Error('down'))),
      } as never,
    );

    const page = await controller.getHistory(request);

    expect(page.items[0].peers.map((peer) => peer.id)).toEqual([
      'friend',
      'gone',
    ]);
  });

  it('rejects an invalid limit or cursor with 400', async () => {
    const callClient = {
      send: jest.fn().mockReturnValue(of({ error: 'invalid_cursor' })),
    };
    const controller = new CallController(
      callClient as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.getHistory(request, undefined, '500'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getHistory(request, 'bad')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('counts and clears missed calls only for the signed-in user', async () => {
    const callClient = {
      send: jest
        .fn()
        .mockReturnValueOnce(of({ count: 3 }))
        .mockReturnValueOnce(of({ updated: 3 })),
    };
    const controller = new CallController(
      callClient as never,
      {} as never,
      {} as never,
    );

    await expect(controller.getMissedCount(request)).resolves.toEqual({
      count: 3,
    });
    await expect(controller.markMissedSeen(request)).resolves.toEqual({
      updated: 3,
    });
    expect(callClient.send).toHaveBeenNthCalledWith(
      1,
      'call.get_missed_count',
      {
        userId: 'me',
      },
    );
    expect(callClient.send).toHaveBeenNthCalledWith(
      2,
      'call.mark_missed_seen',
      {
        userId: 'me',
      },
    );
  });
});
