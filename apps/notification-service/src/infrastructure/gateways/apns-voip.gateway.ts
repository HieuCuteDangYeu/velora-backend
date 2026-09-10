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

type ApnsError = Error & {
  code?: string;
};

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

  async send(input: SendApnsVoipPushInput) {
    const jwt = this.getJwt();
    const url = APNS_HOSTS[input.deliveryEnvironment];
    const session = http2.connect(url);

    return new Promise<void>((resolvePromise, rejectPromise) => {
      const body = JSON.stringify(input.payload);
      const request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${input.token}`,
        authorization: `bearer ${jwt}`,
        'content-type': 'application/json',
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-topic': `${input.bundleId}.voip`,
        // A VoIP push is a wake-up signal for a live call, never a message to
        // deliver later. The recipient validates the call expiry independently.
        'apns-expiration': '0',
      });

      let statusCode = 0;
      let responseBody = '';

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        const statusHeader = headers[':status'];
        if (typeof statusHeader === 'number') {
          statusCode = statusHeader;
        }
      });
      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      request.on('end', () => {
        session.close();

        if (statusCode >= 200 && statusCode < 300) {
          resolvePromise();
          return;
        }

        rejectPromise(this.buildApnsError(statusCode, responseBody));
      });
      request.on('error', (error) => {
        session.destroy();
        rejectPromise(
          error instanceof Error ? error : new Error(String(error)),
        );
      });

      request.end(body);
    });
  }

  private buildApnsError(statusCode: number, responseBody: string) {
    let reason = 'Unknown';

    try {
      const parsed = JSON.parse(responseBody) as { reason?: string };
      if (parsed.reason) {
        reason = parsed.reason;
      }
    } catch {
      if (responseBody.trim()) {
        reason = responseBody.trim();
      }
    }

    const error = new Error(
      `APNs VoIP push failed with status ${statusCode}: ${reason}`,
    ) as ApnsError;
    error.code = `apns/${reason}`;
    return error;
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
