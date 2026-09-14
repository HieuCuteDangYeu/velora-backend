/**
 * Keep call-service diagnostics useful without copying identifiers or native
 * error payloads into logs. Full user ids, SDP/RTP parameters and access
 * tokens must never be logged by the call runtime.
 */
export const shortCallIdentifier = (value: string | null | undefined) => {
  if (!value) return 'unknown';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-3)}`;
};

const SAFE_ERROR_CODE = /^[a-z0-9_:-]{1,64}$/i;

export const safeCallErrorCode = (error: unknown): string => {
  const explicitCode =
    error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof explicitCode === 'string') {
    const normalized = explicitCode.trim().toLowerCase();
    if (SAFE_ERROR_CODE.test(normalized)) return normalized;
  }

  const message = error instanceof Error ? error.message : '';
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/producer/i.test(message)) return 'producer_error';
  if (/consumer/i.test(message)) return 'consumer_error';
  if (/transport/i.test(message)) return 'transport_error';
  if (/socket|connect|network/i.test(message)) return 'socket_error';
  if (/call|room|terminal|ended|closed/i.test(message))
    return 'call_state_error';
  return 'unknown_error';
};
