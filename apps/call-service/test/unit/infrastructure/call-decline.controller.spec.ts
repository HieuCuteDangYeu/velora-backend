import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { CallDeclineTokenService } from '@common/calls/call-decline-token.service';
import { CallDeclineController } from '../../../src/infrastructure/controllers/call-decline.controller';

const tokens = new CallDeclineTokenService({
  get: () => 'test-secret',
} as unknown as ConfigService);

const issue = (invitationId?: string) =>
  tokens.issue({
    callId: 'room-1',
    userId: 'callee',
    ...(invitationId ? { invitationId } : {}),
    ringExpiresAt: new Date(Date.now() + 30_000),
  });

const setup = (rejectForUser = jest.fn().mockResolvedValue(undefined)) => ({
  controller: new CallDeclineController(tokens, { rejectForUser } as never),
  rejectForUser,
});

describe('CallDeclineController', () => {
  it('declines as the token user, never as a caller-chosen one', async () => {
    const { controller, rejectForUser } = setup();
    await expect(
      controller.declineWithToken({ callId: 'room-1', token: issue() }),
    ).resolves.toEqual({ ok: true });
    expect(rejectForUser).toHaveBeenCalledWith({ callId: 'room-1' }, 'callee');
  });

  it('declines the group invitation named by the token', async () => {
    const { controller, rejectForUser } = setup();
    await controller.declineWithToken({
      callId: 'invite-2',
      token: issue('invite-2'),
    });
    expect(rejectForUser).toHaveBeenCalledWith(
      { callId: 'room-1', invitationId: 'invite-2' },
      'callee',
    );
  });

  it('refuses a token for another call, a bad token and a malformed body', async () => {
    const { controller, rejectForUser } = setup();
    const refused = { ok: false, reason: 'invalid_token' };
    await expect(
      controller.declineWithToken({ callId: 'other-call', token: issue() }),
    ).resolves.toEqual(refused);
    await expect(
      controller.declineWithToken({ callId: 'room-1', token: 'a.b' }),
    ).resolves.toEqual(refused);
    await expect(
      controller.declineWithToken({ callId: 'room-1' }),
    ).resolves.toEqual(refused);
    expect(rejectForUser).not.toHaveBeenCalled();
  });

  it('treats an already-answered or ended call as nothing left to decline', async () => {
    const { controller } = setup(
      jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException('Active calls cannot be rejected'),
        ),
    );
    await expect(
      controller.declineWithToken({ callId: 'room-1', token: issue() }),
    ).resolves.toEqual({ ok: false, reason: 'not_declinable' });
  });

  it('surfaces unexpected failures so the caller can retry', async () => {
    const { controller } = setup(
      jest.fn().mockRejectedValue(new Error('redis down')),
    );
    await expect(
      controller.declineWithToken({ callId: 'room-1', token: issue() }),
    ).rejects.toThrow('redis down');
  });
});
