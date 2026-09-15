import { Injectable } from '@nestjs/common';
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
};

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
  private cachedJwt?: {
    token: string;
    expiresAt: number;
  };

  constructor(private readonly metrics: NotificationPrometheusMetricsService) {}

  async send(input: SendApnsVoipPushInput) {
    const jwt = this.getJwt();
    const url = APNS_HOSTS[input.deliveryEnvironment];
    const timeoutMs = this.getRequestTimeoutMs();
    const session = http2.connect(url);

    return new Promise<void>((resolvePromise, rejectPromise) => {
      const body = JSON.stringify(input.payload);
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let statusCode = 0;
      let responseBody = '';

      const complete = (completion: () => void): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        completion();
        return true;
      };

      const fail = (error: ApnsError) => {
        if (complete(() => rejectPromise(error))) {
          this.metrics.recordApnsRequest(this.apnsOutcome(error));
          session.destroy();
        }
      };

      // A ClientHttp2Session emits `error` independently of its request
      // streams. This listener must exist before request() so a connection
      // failure can never become an unhandled EventEmitter error.
      session.on('error', (error) => {
        fail(this.buildTransportError(error));
      });
      session.on('goaway', () => {
        fail(this.buildTransportError('APNs session received GOAWAY'));
      });
      session.on('close', () => {
        fail(this.buildTransportError('APNs session closed before response'));
      });

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
        fail(this.buildTransportError(error));
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
            session.close();
          }
          return;
        }

        fail(this.buildApnsError(statusCode, responseBody));
      });
      request.on('close', () => {
        fail(this.buildTransportError('APNs request closed before response'));
      });
      request.on('error', (error) => {
        fail(this.buildTransportError(error));
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

  private buildTransportError(error: unknown): ApnsError {
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'APNs transport failed';
    const transportError = new Error(
      `APNs VoIP transport failed: ${message}`,
    ) as ApnsError;
    transportError.code = 'apns/transport_error';
    return transportError;
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
