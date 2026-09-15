import { Controller, Get } from '@nestjs/common';

@Controller()
export class NotificationHealthController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
