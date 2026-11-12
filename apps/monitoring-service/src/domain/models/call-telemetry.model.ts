export type TelemetryPlatform = 'ios' | 'android' | 'web';
export type TelemetryDirection = 'incoming' | 'outgoing';
export type TelemetryRole = 'host' | 'guest';
export type TelemetryEventType = 'setup_stage' | 'quality_sample' | 'terminal';
export type TelemetryOutcome = 'started' | 'succeeded' | 'failed' | 'ended';

export type TelemetryJsonValue =
  | string
  | number
  | boolean
  | null
  | TelemetryJsonObject
  | TelemetryJsonValue[];

export type TelemetryJsonObject = {
  [key: string]: TelemetryJsonValue;
};

export type TelemetryQuery = {
  from: string;
  to: string;
  platform?: TelemetryPlatform;
  osVersion?: string;
  appVersion?: string;
  direction?: TelemetryDirection;
};

export type StoredCallTelemetryEvent = {
  eventId: string;
  attemptId: string;
  callId: string | null;
  role: TelemetryRole | null;
  eventType: TelemetryEventType;
  stage: string;
  outcome: TelemetryOutcome | null;
  elapsedMs: number;
  occurredAt: Date;
  platform: TelemetryPlatform;
  appVersion: string;
  osVersion: string | null;
  direction: TelemetryDirection | null;
  errorCode: string | null;
  metricsJson: TelemetryJsonObject | null;
};

export type CallTelemetryTimelineEvent = Omit<
  StoredCallTelemetryEvent,
  'callId'
>;

export type RecentCallLeg = {
  callId: string;
  attemptId: string;
  role: TelemetryRole | null;
  platform: TelemetryPlatform;
  appVersion: string;
  direction: TelemetryDirection | null;
  startedAt: Date;
  lastOccurredAt: Date;
  controlPlaneActive: boolean;
  mediaReady: boolean;
  failure: { stage: string; errorCode: string | null } | null;
};

export type CallTelemetrySummary = {
  attempts: number;
  /** Attempts that ended unanswered; excluded from the success-rate denominators. */
  unansweredAttempts: number;
  controlPlaneSuccessRate: number | null;
  mediaReadySuccessRate: number | null;
  timeToControlPlaneActiveMs: { p50: number | null; p95: number | null };
  timeToFirstRemoteAudioMs: { p50: number | null; p95: number | null };
  failures: Record<string, number>;
  quality: {
    samples: number;
    packetLossRate: number | null;
    jitterMs: number | null;
    roundTripTimeMs: number | null;
    concealmentRate: number | null;
    jitterBufferDelayMs: number | null;
    badSampleRate: number | null;
  };
};
