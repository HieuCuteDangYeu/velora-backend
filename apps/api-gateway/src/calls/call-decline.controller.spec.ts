import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { CallDeclineController } from './call-decline.controller';

const setup = (reply: unknown) => {
  const send = jest.fn().mockReturnValue(of(reply));
  return { controller: new CallDeclineController({ send } as never), send };
};

describe('CallDeclineController (gateway)', () => {
  it('forwards the call id and token to call-service', async () => {
    const { controller, send } = setup({ ok: true });
    await expect(
      controller.decline('call-1', { token: 'signed.token' }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith('call.decline_with_token', {
      callId: 'call-1',
      token: 'signed.token',
    });
  });

  it('answers 403 for a token call-service refuses', async () => {
    const { controller } = setup({ ok: false, reason: 'invalid_token' });
    await expect(controller.decline('call-1', { token: 'x' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('succeeds when the call can no longer be declined', async () => {
    const { controller } = setup({ ok: false, reason: 'not_declinable' });
    await expect(
      controller.decline('call-1', { token: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('rejects a malformed body before reaching call-service', async () => {
    const { controller, send } = setup({ ok: true });
    for (const body of [undefined, {}, { token: '' }, { token: 7 }]) {
      await expect(controller.decline('call-1', body)).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(send).not.toHaveBeenCalled();
  });
});
