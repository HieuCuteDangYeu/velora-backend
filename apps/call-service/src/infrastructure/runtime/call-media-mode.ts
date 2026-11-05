/**
 * `embedded`: mediasoup runs inside this call-service process. Only one
 * instance may run (runtime lease) and startup ends calls whose in-process
 * media was lost. This is the default and the rollback profile.
 *
 * `remote`: this process is a stateless signaling replica. Media runs on
 * separate media nodes reached over RPC, so any number of replicas may run.
 */
export type CallMediaMode = 'embedded' | 'remote';

export function readCallMediaMode(
  value: string | undefined = process.env.CALL_MEDIA_MODE,
): CallMediaMode {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'embedded') return 'embedded';
  if (normalized === 'remote') return 'remote';
  throw new Error(
    `CALL_MEDIA_MODE must be "embedded" or "remote" (got "${value}")`,
  );
}
