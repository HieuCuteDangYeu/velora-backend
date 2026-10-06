import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
// This is a separate client for telemetry. Apply the same connection budget
// and lifecycle as the main monitoring client; the limit is per client.
export class MonitoringPrismaService extends PrismaService {}
