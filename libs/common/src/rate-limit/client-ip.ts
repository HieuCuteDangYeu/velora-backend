import { isIPv6 } from 'node:net';

export interface ClientIpRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/**
 * Resolves the rate-limit identity of a client.
 *
 * `req.ip` is only the real client when Express `trust proxy` matches the
 * deployment (see TRUST_PROXY_HOPS in the gateway bootstrap). When the platform
 * injects a header that the edge overwrites (for example a tunnel's
 * CF-Connecting-IP), set RATE_LIMIT_CLIENT_IP_HEADER to read it instead. Only
 * set it when nothing in front of the gateway lets a client forge that header.
 *
 * IPv6 clients are bucketed by /64: one subscriber normally controls a whole /64,
 * so per-address buckets would be trivially bypassed.
 */
export function resolveClientIp(
  request: ClientIpRequest,
  headerName?: string,
): string {
  const fromHeader = headerName
    ? firstHeaderValue(request.headers?.[headerName.toLowerCase()])
    : undefined;
  const raw = fromHeader ?? request.ip ?? request.socket?.remoteAddress;
  return raw ? normalizeIp(raw) : 'unknown';
}

function firstHeaderValue(value: string | string[] | undefined) {
  const first = Array.isArray(value) ? value[0] : value;
  const candidate = first?.split(',')[0]?.trim();
  return candidate ? candidate : undefined;
}

export function normalizeIp(value: string): string {
  const ip = value.trim().replace(/^::ffff:/i, '');
  if (!isIPv6(ip)) return ip;
  const hextets = expandIPv6(ip);
  return hextets ? `${hextets.slice(0, 4).join(':')}::/64` : ip;
}

function expandIPv6(ip: string): string[] | undefined {
  const [head, tail, ...rest] = ip.split('::');
  if (rest.length > 0) return undefined;
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined ? headParts.length !== 8 : missing < 0)
    return undefined;
  const parts = [
    ...headParts,
    ...Array<string>(tail === undefined ? 0 : missing).fill('0'),
    ...tailParts,
  ];
  return parts.length === 8
    ? parts.map((part) => part.toLowerCase().padStart(4, '0'))
    : undefined;
}
