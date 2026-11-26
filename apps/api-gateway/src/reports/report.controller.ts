import { RateLimit } from '@common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '@common/rate-limit/rate-limit.guard';
import { ReportContentDto } from '@common/reports/report-content.dto';
import { Role, Roles } from '@gateway/auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { LEGAL_CONTACT_EMAIL } from '../legal/legal-pages';

/**
 * Reports of objectionable content or users (App Review guideline 1.2). Each
 * report is e-mailed to the moderator address published in the terms, who
 * acts on it within 24 hours; the app blocks the reported user for the
 * reporter at the same time.
 */
@ApiTags('Reports')
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
export class ReportController {
  private readonly logger = new Logger(ReportController.name);

  constructor(
    @Inject('MAIL_SERVICE') private readonly mailClient: ClientProxy,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(Role.ADMIN, Role.USER)
  @RateLimit({ policy: 'report_user', by: 'user' })
  @ApiOperation({ summary: 'Report a user, message, reel or comment' })
  report(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ReportContentDto,
  ): { status: 'received' } {
    const reporter = request.user!;
    const lines = [
      'A Velora user reported content.',
      '',
      `Reason: ${dto.reason}`,
      `Target: ${dto.targetType} ${dto.targetId}`,
      dto.targetUserId ? `Author: ${dto.targetUserId}` : undefined,
      dto.conversationId ? `Conversation: ${dto.conversationId}` : undefined,
      `Reporter: ${reporter.id}`,
      `Received: ${new Date().toISOString()}`,
      '',
      dto.details
        ? `Details from the reporter:\n${dto.details}`
        : 'No details given.',
      '',
      'Review within 24 hours; remove content that breaks the terms and ban the account responsible.',
    ].filter((line): line is string => line !== undefined);

    this.mailClient.emit('mail.send', {
      to: LEGAL_CONTACT_EMAIL,
      subject: `[Velora report] ${dto.reason} · ${dto.targetType}`,
      template: 'plain-text',
      context: {},
      text: lines.join('\n'),
    });
    this.logger.log(`Report received: ${dto.targetType} ${dto.reason}`);

    return { status: 'received' };
  }
}
