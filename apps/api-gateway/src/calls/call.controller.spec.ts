import { GUARDS_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
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
