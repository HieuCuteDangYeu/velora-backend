import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { lastValueFrom, timeout } from 'rxjs';
import { z } from 'zod';

const DeclineCallSchema = z.object({
  token: z.string().min(1).max(2048),
});

type DeclineWithTokenResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_token' | 'not_declinable' };

/**
 * No JWT: the Android notification Decline button calls this while the app
 * process is dead. The signed decline token from the incoming-call push is
 * the credential, and call-service verifies it.
 */
@ApiTags('Calls')
@Controller('calls')
export class CallDeclineController {
  constructor(
    @Inject('CALL_SERVICE') private readonly callClient: ClientProxy,
  ) {}

  @Post(':callId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Decline an incoming call with the token from its push',
  })
  async decline(@Param('callId') callId: string, @Body() body: unknown) {
    const parsed = DeclineCallSchema.safeParse(body);
    if (!parsed.success || !callId || callId.length > 200) {
      throw new BadRequestException('Invalid decline request');
    }

    const result = await lastValueFrom(
      this.callClient
        .send<DeclineWithTokenResult>('call.decline_with_token', {
          callId,
          token: parsed.data.token,
        })
        .pipe(timeout(5000)),
    );
    if (!result.ok && result.reason === 'invalid_token') {
      throw new ForbiddenException('Invalid decline token');
    }
    // `not_declinable` (already answered or ended) leaves nothing to undo on
    // the device, so it is a success from the caller's point of view.
  }
}
