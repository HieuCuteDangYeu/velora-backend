import type { TurnIceServer } from '../../domain/interfaces/call-media.engine.interface';

export const readTurnIceServers = (
  env: NodeJS.ProcessEnv = process.env,
): TurnIceServer[] | undefined => {
  const rawUrls = env.TURN_URLS?.trim();
  const username = env.TURN_USERNAME?.trim();
  const credential = env.TURN_CREDENTIAL;

  // No TURN settings preserves the existing direct-to-SFU deployment.
  if (!rawUrls && !username && !credential?.trim()) return undefined;

  if (!rawUrls || !username || !credential?.trim()) {
    throw new Error(
      'TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL must all be configured',
    );
  }

  const urls = rawUrls.split(',').map((url) => url.trim());
  for (const url of urls) {
    // TURN uses URI syntax (turn:host), not HTTP URL syntax (turn://host).
    const match = url.match(
      /^turns?:([a-z0-9.-]+|\[[a-f0-9:]+\])(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/i,
    );
    if (
      !match ||
      (match[2] && !(Number(match[2]) >= 1 && Number(match[2]) <= 65535))
    ) {
      // Never include URLs or credentials in errors or logs.
      throw new Error(
        'TURN_URLS must contain valid turn: or turns: server URIs',
      );
    }
  }

  return [{ urls, username, credential }];
};
