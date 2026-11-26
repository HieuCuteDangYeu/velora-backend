import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http2 from 'node:http2';
import { resolve } from 'node:path';

import {
  IApnsVoipGateway,
  SendApnsVoipPushInput,
} from '../../domain/interfaces/apns-voip.gateway.interface';
import { PushDeliveryEnvironment } from '../../domain/entities/push-token.entity';
import {
  ApnsRequestOutcome,
  NotificationPrometheusMetricsService,
} from '../metrics/notification-prometheus-metrics.service';

type ApnsError = Error & {
  code?: string;
  /** Where a transport failure was observed, for the log only. */
  transportStage?: string;
  /** The Node error code behind a transport failure, for the log only. */
  transportCause?: string;
};

/**
 * A VoIP push matters only while the call rings, so a transport failure gets
 * one immediate retry on a fresh connection instead of waiting for the job
 * scheduler. Without it, a recipient with a second device whose push did get
 * through has the job marked sent and this device never rings.
 */
const APNS_TRANSPORT_RETRY_DELAY_MS = 200;

const DEFAULT_APNS_REQUEST_TIMEOUT_MS = 5_000;
const MIN_APNS_REQUEST_TIMEOUT_MS = 1_000;
const MAX_APNS_REQUEST_TIMEOUT_MS = 15_000;
const APNS_INVALID_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
]);

const APNS_HOSTS: Record<PushDeliveryEnvironment, string> = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

@Injectable()
export class ApnsVoipGateway implements IApnsVoipGateway {
  private readonly logger = new Logger(ApnsVoipGateway.name);
  /**
   * One long-lived HTTP/2 connection per APNs environment. Apple asks
   * providers to keep connections open across notifications and may refuse
   * rapid connect/disconnect cycles; a new connection per push showed up as
   * streams cancelled in pairs (ERR_HTTP2_STREAM_CANCEL) on 26 Nov 2026.
   */
  private readonly sessions = new Map<
    PushDeliveryEnvironment,
    http2.ClientHttp2Session
  >();
  private cachedJwt?: {
    token: string;
    expiresAt: number;
  };

  constructor(private readonly metrics: NotificationPrometheusMetricsService) {}

  async send(input: SendApnsVoipPushInput) {
    try {
      return await this.sendOnce(input);
    } catch (error) {
      const firstError = error as ApnsError;
      if (firstError.code !== 'apns/transport_error') throw error;
      this.logTransportFailure(firstError, input, 'retrying');
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, APNS_TRANSPORT_RETRY_DELAY_MS),
      );
      try {
        return await this.sendOnce(input);
      } catch (retryError) {
        if ((retryError as ApnsError).code === 'apns/transport_error') {
          this.logTransportFailure(retryError as ApnsError, input, 'giving up');
        }
        throw retryError;
      }
    }
  }

  private getSession(environment: PushDeliveryEnvironment) {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = http2.connect(APNS_HOSTS[environment]);
    const forget = () => {
      if (this.sessions.get(environment) === session) {
        this.sessions.delete(environment);
      }
    };
    // Always attached: a connection error must never be unhandled, and a
    // session that can no longer carry requests leaves the pool at once.
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    // An idle push connection must not keep the process alive at shutdown.
    if (typeof session.unref === 'function') session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  private dropSession(
    environment: PushDeliveryEnvironment,
    session: http2.ClientHttp2Session,
  ) {
    if (this.sessions.get(environment) === session) {
      this.sessions.delete(environment);
    }
    session.destroy();
  }

  private async sendOnce(input: SendApnsVoipPushInput) {
    const jwt = this.getJwt();
    const timeoutMs = this.getRequestTimeoutMs();
    const session = this.getSession(input.deliveryEnvironment);

    return new Promise<void>((resolvePromise, rejectPromise) => {
      const body = JSON.stringify(input.payload);
      let settled = false;
      // Assigned after listeners are attached; a synchronous request failure needs the unset state.
      // eslint-disable-next-line prefer-const
      let timeout: NodeJS.Timeout | undefined;
      let statusCode = 0;
      let responseBody = '';

      const onSessionError = (error: unknown) => {
        fail(this.buildTransportError('session_error', error));
      };
      const onSessionGoaway = (errorCode: unknown) => {
        fail(this.buildTransportError('goaway', errorCode));
      };
      const onSessionClose = () => {
        fail(this.buildTransportError('session_close'));
      };

      const complete = (completion: () => void): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        // The session outlives this request; its per-request listeners must not.
        session.off('error', onSessionError);
        session.off('goaway', onSessionGoaway);
        session.off('close', onSessionClose);
        completion();
        return true;
      };

      const fail = (error: ApnsError) => {
        if (complete(() => rejectPromise(error))) {
          this.metrics.recordApnsRequest(this.apnsOutcome(error));
          // A transport failure or timeout means the connection is suspect,
          // so the retry gets a new one. An APNs rejection keeps it.
          if (
            error.code === 'apns/transport_error' ||
            error.code === 'apns/timeout'
          ) {
            this.dropSession(input.deliveryEnvironment, session);
          }
        }
      };

      session.on('error', onSessionError);
      session.on('goaway', onSessionGoaway);
      session.on('close', onSessionClose);

      let request: http2.ClientHttp2Stream;
      try {
        request = session.request({
          ':method': 'POST',
          ':path': `/3/device/${input.token}`,
          authorization: `bearer ${jwt}`,
          'content-type': 'application/json',
          'apns-push-type': 'voip',
          'apns-priority': '10',
          'apns-topic': `${input.bundleId}.voip`,
          // A VoIP push is a wake-up signal for a live call, never a message
          // to deliver later. The recipient validates the call expiry.
          'apns-expiration': '0',
        });
      } catch (error) {
        fail(this.buildTransportError('request_throw', error));
        return;
      }

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        const statusHeader = headers[':status'];
        if (typeof statusHeader === 'number') {
          statusCode = statusHeader;
        }
      });
      request.on('data', (chunk: string) => {
        // APNs returns a small JSON reason for non-2xx responses. It is used
        // only to retire known-invalid tokens and is never logged or labeled.
        responseBody += chunk;
      });
      request.on('end', () => {
        if (statusCode >= 200 && statusCode < 300) {
          if (complete(resolvePromise)) {
            this.metrics.recordApnsRequest('success');
          }
          return;
        }

        this.logRejection(statusCode, responseBody, input);
        fail(this.buildApnsError(statusCode, responseBody));
      });
      request.on('close', () => {
        fail(this.buildTransportError('stream_close', request.rstCode));
      });
      request.on('error', (error: unknown) => {
        fail(this.buildTransportError('stream_error', error));
      });

      timeout = setTimeout(() => {
        const error = new Error(
          `APNs VoIP push timed out after ${timeoutMs}ms`,
        ) as ApnsError;
        error.code = 'apns/timeout';
        fail(error);
      }, timeoutMs);

      request.end(body);
    });
  }

  /**
   * Apple's `reason` is a fixed enum string such as `BadDeviceToken` or
   * `InvalidProviderToken`; without it every rejection looks the same. The
   * device token and payload are never logged.
   */
  private logRejection(
    statusCode: number,
    responseBody: string,
    input: SendApnsVoipPushInput,
  ) {
    let reason = 'unknown';
    try {
      const parsed = JSON.parse(responseBody) as { reason?: unknown };
      if (
        typeof parsed.reason === 'string' &&
        /^[A-Za-z]{1,64}$/.test(parsed.reason)
      ) {
        reason = parsed.reason;
      }
    } catch {
      // Keep the placeholder; the status code is still useful.
    }

    this.logger.warn(
      `APNs VoIP push rejected: status=${statusCode} reason=${reason} environment=${input.deliveryEnvironment} topic=${input.bundleId}.voip`,
    );
  }

  private buildApnsError(statusCode: number, responseBody: string) {
    const error = new Error(
      `APNs VoIP push failed with HTTP status ${statusCode}`,
    ) as ApnsError;
    error.code = this.parseApnsErrorCode(responseBody);
    return error;
  }

  private parseApnsErrorCode(responseBody: string) {
    try {
      const parsed = JSON.parse(responseBody) as { reason?: unknown };
      if (
        typeof parsed.reason === 'string' &&
        APNS_INVALID_TOKEN_REASONS.has(parsed.reason)
      ) {
        return `apns/${parsed.reason}`;
      }
    } catch {
      // Unknown response bodies are intentionally normalized below.
    }

    return 'apns/http_error';
  }

  private apnsOutcome(error: ApnsError): ApnsRequestOutcome {
    if (error.code === 'apns/timeout') {
      return 'timeout';
    }
    if (error.code?.startsWith('apns/transport_')) {
      return 'transport_error';
    }
    return 'http_error';
  }

  private buildTransportError(stage: string, cause?: unknown): ApnsError {
    const transportError = new Error('APNs VoIP transport failed') as ApnsError;
    transportError.code = 'apns/transport_error';
    transportError.transportStage = stage;
    transportError.transportCause = this.describeTransportCause(cause);
    return transportError;
  }

  /** Only a short error code or number is kept; messages may carry hosts. */
  private describeTransportCause(cause: unknown) {
    const candidate =
      typeof cause === 'number'
        ? String(cause)
        : cause && typeof cause === 'object' && 'code' in cause
          ? String((cause as { code?: unknown }).code)
          : undefined;
    return candidate && /^[A-Za-z0-9_]{1,48}$/.test(candidate)
      ? candidate
      : 'none';
  }

  private logTransportFailure(
    error: ApnsError,
    input: SendApnsVoipPushInput,
    action: 'retrying' | 'giving up',
  ) {
    this.logger.warn(
      `APNs VoIP transport failed (${action}): stage=${error.transportStage ?? 'unknown'} cause=${error.transportCause ?? 'none'} environment=${input.deliveryEnvironment}`,
    );
  }

  private getRequestTimeoutMs() {
    const configured = process.env.NOTIFICATION_APNS_REQUEST_TIMEOUT_MS;
    if (configured === undefined || configured === '') {
      return DEFAULT_APNS_REQUEST_TIMEOUT_MS;
    }

    const timeoutMs = Number(configured);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_APNS_REQUEST_TIMEOUT_MS ||
      timeoutMs > MAX_APNS_REQUEST_TIMEOUT_MS
    ) {
      throw new Error(
        `NOTIFICATION_APNS_REQUEST_TIMEOUT_MS must be an integer between ${MIN_APNS_REQUEST_TIMEOUT_MS} and ${MAX_APNS_REQUEST_TIMEOUT_MS}`,
      );
    }

    return timeoutMs;
  }

  private getJwt() {
    if (this.cachedJwt && this.cachedJwt.expiresAt > Date.now() + 60_000) {
      return this.cachedJwt.token;
    }

    const teamId = process.env.NOTIFICATION_APNS_TEAM_ID;
    const keyId = process.env.NOTIFICATION_APNS_KEY_ID;
    const privateKeyPath = process.env.NOTIFICATION_APNS_PRIVATE_KEY_PATH;

    if (!teamId || !keyId || !privateKeyPath) {
      throw new Error(
        'Missing APNs VoIP credentials: NOTIFICATION_APNS_TEAM_ID, NOTIFICATION_APNS_KEY_ID, NOTIFICATION_APNS_PRIVATE_KEY_PATH',
      );
    }

    const absolutePrivateKeyPath = resolve(process.cwd(), privateKeyPath);
    const privateKey = readFileSync(absolutePrivateKeyPath, 'utf8');
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = this.base64UrlEncode(
      JSON.stringify({
        alg: 'ES256',
        kid: keyId,
      }),
    );
    const payload = this.base64UrlEncode(
      JSON.stringify({
        iss: teamId,
        iat: issuedAt,
      }),
    );
    const unsignedToken = `${header}.${payload}`;
    const signer = createSign('SHA256');

    signer.update(unsignedToken);
    signer.end();

    const signature = signer.sign(
      {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      },
      'base64url',
    );
    const token = `${unsignedToken}.${signature}`;

    this.cachedJwt = {
      token,
      expiresAt: Date.now() + 50 * 60 * 1000,
    };

    return token;
  }

  private base64UrlEncode(value: string) {
    return Buffer.from(value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }
}
