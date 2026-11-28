import { z } from 'zod';

const finiteNumber = z.number().finite();
const telemetryPlatform = z.enum(['ios', 'android', 'web']);
const telemetryDirection = z.enum(['incoming', 'outgoing']);
const audioRouteType = z.enum([
  'receiver',
  'speaker',
  'bluetooth_hfp',
  'bluetooth_a2dp',
  'bluetooth_le',
  'headphones',
  'airplay',
  'car_audio',
  'usb_audio',
  'line_out',
  'other',
]);

const iceCandidateType = z.enum(['host', 'srflx', 'prflx', 'relay', 'unknown']);

export const CallTelemetryEventSchema = z
  .object({
    eventId: z.string().uuid(),
    attemptId: z.string().uuid(),
    telemetryToken: z.string().min(20).max(2048).optional(),
    eventType: z.enum(['setup_stage', 'quality_sample', 'terminal']),
    stage: z.string().min(1).max(64),
    outcome: z.enum(['started', 'succeeded', 'failed', 'ended']).optional(),
    elapsedMs: finiteNumber.min(0).max(86_400_000),
    occurredAt: z.string().datetime(),
    platform: telemetryPlatform,
    appVersion: z.string().min(1).max(64),
    osVersion: z.string().min(1).max(64).optional(),
    direction: telemetryDirection.optional(),
    errorCode: z.string().min(1).max(80).optional(),
    metrics: z
      .object({
        packetLossRate: finiteNumber.min(0).max(1).nullable().optional(),
        jitterMs: finiteNumber.min(0).max(60_000).nullable().optional(),
        roundTripTimeMs: finiteNumber.min(0).max(60_000).nullable().optional(),
        concealmentRate: finiteNumber.min(0).max(1).nullable().optional(),
        jitterBufferDelayMs: finiteNumber
          .min(0)
          .max(60_000)
          .nullable()
          .optional(),
        packetsReceivedDelta: finiteNumber.min(0).nullable().optional(),
        bytesReceivedDelta: finiteNumber.min(0).nullable().optional(),
      })
      .strict()
      .optional(),
    details: z
      .object({
        audioRoute: z
          .object({
            category: z.enum(['play_and_record', 'other']),
            mode: z.enum(['voice_chat', 'other']),
            outputRouteTypes: z.array(audioRouteType).max(4),
            inputRouteTypes: z.array(audioRouteType).max(4),
            forcedSpeaker: z.boolean(),
          })
          .strict()
          .optional(),
        // The ICE candidate pair a transport selected: shows whether a call
        // went direct or through the TURN relay, and over which protocol.
        icePath: z
          .object({
            transport: z.enum(['send', 'recv']),
            localCandidateType: iceCandidateType,
            remoteCandidateType: iceCandidateType,
            protocol: z.enum(['udp', 'tcp', 'unknown']),
            relayProtocol: z.enum(['udp', 'tcp', 'tls', 'unknown']).nullable(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const TrackCallTelemetrySchema = z
  .object({
    events: z.array(CallTelemetryEventSchema).min(1).max(50),
  })
  .strict();

export const CallTelemetryQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    platform: telemetryPlatform.optional(),
    osVersion: z.string().min(1).max(64).optional(),
    appVersion: z.string().min(1).max(64).optional(),
    direction: telemetryDirection.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (new Date(query.from) > new Date(query.to)) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'to must be greater than or equal to from',
      });
    }
  });

export const CallTelemetryTimelineSchema = z
  .object({
    callId: z.string().uuid(),
  })
  .strict();

export type CallTelemetryEventPayload = z.infer<
  typeof CallTelemetryEventSchema
>;
export type TrackCallTelemetryPayload = z.infer<
  typeof TrackCallTelemetrySchema
>;
export type CallTelemetryQueryPayload = z.infer<
  typeof CallTelemetryQuerySchema
>;
export type CallTelemetryTimelinePayload = z.infer<
  typeof CallTelemetryTimelineSchema
>;
