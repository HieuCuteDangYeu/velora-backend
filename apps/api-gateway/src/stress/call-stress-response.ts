import { z } from 'zod';
// Strip unexpected fields before a host companion response reaches the browser.
const Measurement = z.number().finite().nonnegative();
const RunSchema = z.object({
  id: z.string().uuid(),
  preset: z.enum(['smoke', 'demo']),
  status: z.enum(['running', 'stopping', 'passed', 'failed', 'cancelled']),
  phase: z.string().max(40),
  source: z.literal('host-local'),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  currentCalls: Measurement.max(5),
  failure: z.string().max(160).nullable(),
  progress: z
    .object({
      seconds: Measurement.max(30),
      calls: Measurement.max(5),
      stalled: z.boolean(),
    })
    .nullish(),
  stages: z
    .array(
      z.object({
        calls: Measurement.max(5),
        seconds: Measurement.max(30),
        passed: z.boolean(),
        packetsMin: Measurement.nullable(),
        packetsMax: Measurement.nullable(),
        reportedLost: z.number().finite(),
        jitterMs: Measurement.nullable(),
        leaveReceipts: Measurement.max(5),
        logoutRevoked: Measurement.max(10),
      }),
    )
    .max(3),
  samples: z
    .array(
      z.object({
        at: z.string().datetime(),
        rooms: Measurement,
        sockets: Measurement,
        workerCpu: Measurement,
        callMemory: Measurement,
        hostCpu: Measurement,
      }),
    )
    .max(241),
});
const StateSchema = z.object({
  available: z.literal(true),
  busy: z.boolean(),
  source: z.literal('host-local'),
  active: RunSchema.nullable(),
  recent: z.array(RunSchema).max(5),
  fixtureParticipants: Measurement.max(10),
  fixtureRooms: Measurement.max(5),
});
export const CallStressResponseSchema = z.union([StateSchema, RunSchema]);
