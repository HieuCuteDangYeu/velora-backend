import { Logger } from '@nestjs/common';
import type { MediaPublicAddressStatus } from '../../domain/interfaces/call-media.engine.interface';
import {
  isPublicIpv4,
  validateMediasoupNetworkConfiguration,
} from './mediasoup-network-configuration';
import {
  DEFAULT_PUBLIC_IP_STUN_SERVERS,
  parseStunServers,
  queryStunPublicIpv4,
  type StunServer,
} from './stun-public-ip';

type AnnouncedIpMode = 'static' | 'stun';
type StunLookup = (server: StunServer) => Promise<string>;
type IceCandidateAddress = { address: string; ip?: string };

const STUN_TIMEOUT_MS = 2000;
export const PUBLIC_IP_CHECK_INTERVAL_MS = 30_000;
// One odd STUN answer must not move every new call to another address.
const ANSWERS_TO_CHANGE_ADDRESS = 2;

const readMode = (value: string | undefined): AnnouncedIpMode => {
  const mode = value?.trim().toLowerCase() || 'static';
  if (mode !== 'static' && mode !== 'stun') {
    throw new Error('MEDIASOUP_ANNOUNCED_IP_MODE must be static or stun');
  }
  return mode;
};

/**
 * The public address phones are told to send media to. In `stun` mode it
 * follows the ISP: the address is detected at startup and rechecked while
 * the service runs, and MEDIASOUP_ANNOUNCED_IP is only the fallback. The
 * address is never logged.
 */
export class MediasoupPublicAddress {
  private readonly logger = new Logger(MediasoupPublicAddress.name);
  private readonly environment?: string;
  private readonly mode: AnnouncedIpMode;
  private readonly configuredAddress?: string;
  private readonly stunServers: StunServer[];
  private address?: string;
  private pending?: { address: string; answers: number };
  private lastCheckSucceeded = false;
  private lastSuccessAtMs = 0;
  private changes = 0;
  private checking?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly lookup: StunLookup = (server) =>
      queryStunPublicIpv4(server, STUN_TIMEOUT_MS),
    private readonly now: () => number = Date.now,
  ) {
    this.environment = env.NODE_ENV;
    this.mode = readMode(env.MEDIASOUP_ANNOUNCED_IP_MODE);
    this.configuredAddress = env.MEDIASOUP_ANNOUNCED_IP?.trim() || undefined;
    this.stunServers =
      this.mode === 'stun'
        ? parseStunServers(
            env.MEDIASOUP_PUBLIC_IP_STUN_SERVERS?.trim() ||
              DEFAULT_PUBLIC_IP_STUN_SERVERS,
          )
        : [];
    this.address = this.configuredAddress;
  }

  current(): string | undefined {
    return this.address;
  }

  async initialize(): Promise<void> {
    // The configured address must be valid even when it is only the fallback.
    if (this.mode === 'static' || this.configuredAddress) {
      validateMediasoupNetworkConfiguration({
        environment: this.environment,
        announcedIp: this.configuredAddress,
      });
    }
    if (this.mode === 'static') return;

    const detected = await this.detect();
    if (detected) {
      this.address = detected;
      this.recordSuccess();
      return;
    }

    if (!this.configuredAddress) {
      if (this.environment?.toLowerCase() === 'production') {
        throw new Error(
          'MEDIASOUP_ANNOUNCED_IP_MODE=stun found no public IPv4 and MEDIASOUP_ANNOUNCED_IP has no fallback',
        );
      }
      return;
    }
    this.logger.warn(
      'STUN public IPv4 detection failed at startup; announcing the MEDIASOUP_ANNOUNCED_IP fallback',
    );
  }

  start(intervalMs = PUBLIC_IP_CHECK_INTERVAL_MS): void {
    if (this.mode !== 'stun' || this.timer) return;
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  check(): Promise<void> {
    this.checking ??= this.recheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  /**
   * A WebRtcServer keeps the address its worker started with, but phones only
   * learn the address from these candidates. Every candidate comes from the
   * single UDP listen address, so each one gets the current public address.
   */
  announce<T extends IceCandidateAddress>(candidates: T[]): T[] {
    const address = this.address;
    if (this.mode !== 'stun' || !address) return candidates;
    return candidates.map((candidate) =>
      candidate.address === address
        ? candidate
        : { ...candidate, address, ip: address },
    );
  }

  status(): MediaPublicAddressStatus {
    return {
      detectionEnabled: this.mode === 'stun',
      lastCheckSucceeded: this.lastCheckSucceeded,
      lastSuccessTimestampSeconds: this.lastSuccessAtMs / 1000,
      changes: this.changes,
      mismatch: this.pending !== undefined,
    };
  }

  private async recheck(): Promise<void> {
    const detected = await this.detect();
    if (!detected) {
      if (this.lastCheckSucceeded) {
        this.logger.warn(
          'STUN public IPv4 check failed; new transports keep the last known address',
        );
      }
      this.lastCheckSucceeded = false;
      return;
    }

    if (!this.lastCheckSucceeded) {
      this.logger.log('STUN public IPv4 check succeeded again');
    }
    this.recordSuccess();

    if (detected === this.address) {
      this.pending = undefined;
      return;
    }

    const answers =
      this.pending?.address === detected ? this.pending.answers + 1 : 1;
    if (answers < ANSWERS_TO_CHANGE_ADDRESS) {
      this.pending = { address: detected, answers };
      return;
    }

    this.pending = undefined;
    this.address = detected;
    this.changes += 1;
    this.logger.warn(
      'Mediasoup public IPv4 changed; new transports announce the detected address',
    );
  }

  private async detect(): Promise<string | undefined> {
    for (const server of this.stunServers) {
      try {
        const address = await this.lookup(server);
        if (isPublicIpv4(address)) return address;
      } catch {
        // Try the next server; a failed lookup carries nothing worth logging.
      }
    }
    return undefined;
  }

  private recordSuccess(): void {
    this.lastCheckSucceeded = true;
    this.lastSuccessAtMs = this.now();
  }
}
