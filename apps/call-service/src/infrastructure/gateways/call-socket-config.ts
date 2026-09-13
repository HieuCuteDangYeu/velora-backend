const DEFAULT_CALL_SOCKET_PING_INTERVAL_MS = 25_000;
const DEFAULT_CALL_SOCKET_PING_TIMEOUT_MS = 20_000;
const MIN_CALL_SOCKET_HEARTBEAT_MS = 10_000;

const parseHeartbeatMs = (
  name: string,
  rawValue: string | undefined,
  fallback: number,
): number => {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isFinite(value) || value < MIN_CALL_SOCKET_HEARTBEAT_MS) {
    throw new Error(
      `${name} must be a finite duration of at least ${MIN_CALL_SOCKET_HEARTBEAT_MS}ms`,
    );
  }
  return Math.floor(value);
};

export type CallSocketHeartbeatConfig = {
  pingInterval: number;
  pingTimeout: number;
};

export const getCallSocketHeartbeatConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): CallSocketHeartbeatConfig => ({
  pingInterval: parseHeartbeatMs(
    'CALL_SOCKET_PING_INTERVAL_MS',
    environment.CALL_SOCKET_PING_INTERVAL_MS,
    DEFAULT_CALL_SOCKET_PING_INTERVAL_MS,
  ),
  pingTimeout: parseHeartbeatMs(
    'CALL_SOCKET_PING_TIMEOUT_MS',
    environment.CALL_SOCKET_PING_TIMEOUT_MS,
    DEFAULT_CALL_SOCKET_PING_TIMEOUT_MS,
  ),
});
