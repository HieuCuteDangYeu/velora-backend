import { RpcException } from '@nestjs/microservices';

export type TimeRangePayload = {
  from?: unknown;
  to?: unknown;
  stepSeconds?: unknown;
};

export type TimeRange = {
  from: string;
  to: string;
  stepSeconds: number;
};

const MAX_RANGE_MS = 24 * 60 * 60 * 1000;

const badRequest = (message: string) =>
  new RpcException({ statusCode: 400, message });

/**
 * Shared bounds for every Prometheus range query exposed to the dashboard:
 * a valid increasing window of at most 24 hours and 10–300 second steps.
 */
export const parseTimeRange = (
  payload: TimeRangePayload | null | undefined,
): TimeRange => {
  const from = payload?.from;
  const to = payload?.to;
  const requestedStep = Number(payload?.stepSeconds ?? 10);

  if (typeof from !== 'string' || typeof to !== 'string') {
    throw badRequest('from and to are required ISO timestamps');
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw badRequest('from and to must define a valid increasing time range');
  }

  if (toMs - fromMs > MAX_RANGE_MS) {
    throw badRequest('monitoring timeseries range cannot exceed 24 hours');
  }

  if (
    !Number.isInteger(requestedStep) ||
    requestedStep < 10 ||
    requestedStep > 300
  ) {
    throw badRequest('stepSeconds must be an integer between 10 and 300');
  }

  return { from, to, stepSeconds: requestedStep };
};
