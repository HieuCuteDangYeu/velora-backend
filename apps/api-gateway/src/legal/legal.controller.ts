import { RateLimit } from '@common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '@common/rate-limit/rate-limit.guard';
import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import {
  LEGAL_CONTACT_EMAIL,
  privacyPolicyHtml,
  termsHtml,
} from './legal-pages';

/**
 * Public privacy policy and terms of use. App Store Connect and the app link
 * here, so the pages must be reachable without signing in.
 */
@ApiExcludeController()
@Controller('legal')
@UseGuards(RateLimitGuard)
export class LegalController {
  @Get('privacy')
  @RateLimit({ policy: 'public_share_ip', by: 'ip' })
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  privacy(): string {
    return privacyPolicyHtml(LEGAL_CONTACT_EMAIL);
  }

  @Get('terms')
  @RateLimit({ policy: 'public_share_ip', by: 'ip' })
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  terms(): string {
    return termsHtml(LEGAL_CONTACT_EMAIL);
  }
}
