import { Role, Roles } from '@gateway/auth/decorators/roles.decorator';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { StressRunsService } from './stress-runs.service';

// Only a scenario name and bounded numbers/flags cross this boundary; the agent validates the ranges.
const StartSchema = z
  .object({
    scenario: z.enum(['chat', 'sockets', 'calls', 'mixed']),
    params: z
      .record(z.string().max(30), z.union([z.number().finite(), z.boolean()]))
      .refine((value) => Object.keys(value).length <= 10),
    requestId: z.string().uuid(),
  })
  .strict();
const IdSchema = z.string().uuid();

@Controller('monitoring/stress/runs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class StressRunsController {
  constructor(private readonly runner: StressRunsService) {}

  @Get()
  status(@Req() request: AuthenticatedRequest) {
    return this.runner.request('GET', '/runs', this.token(request));
  }

  @Post()
  start(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    this.assertMutationOrigin(request);
    const parsed = StartSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        'Choose a scenario with numeric settings and provide a request UUID',
      );
    return this.runner.request(
      'POST',
      '/runs',
      this.token(request),
      parsed.data,
    );
  }

  @Post(':id/stop')
  stop(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    this.assertMutationOrigin(request);
    if (!IdSchema.safeParse(id).success)
      throw new BadRequestException('Run ID must be a UUID');
    return this.runner.request(
      'POST',
      `/runs/${id}/stop`,
      this.token(request),
      {},
    );
  }

  private token(request: AuthenticatedRequest) {
    return (
      request.cookies?.access_token ||
      request.headers.authorization?.replace(/^Bearer /, '') ||
      ''
    );
  }

  private assertMutationOrigin(request: AuthenticatedRequest) {
    // Cookie-authenticated load generation must not be triggered by a cross-site form.
    const origin = request.headers.origin;
    const allowed = new Set(['https://dashboard.velora-app.me']);
    if (process.env.NODE_ENV !== 'production') {
      allowed.add('http://localhost:5173');
      allowed.add('http://127.0.0.1:5173');
    }
    if (origin && allowed.has(origin)) return;
    if (
      !origin &&
      request.headers.authorization?.startsWith('Bearer ') &&
      !request.cookies?.access_token
    )
      return;
    throw new ForbiddenException(
      'Start and stop must come from the dashboard origin',
    );
  }
}
