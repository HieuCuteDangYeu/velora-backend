import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CipherGCM, DecipherGCM } from 'crypto';
import * as crypto from 'crypto';
import { IEncryptionRepository } from '../../domain/interfaces/encryption.repository.interface';

export const GCM_IV_BYTES = 12;

@Injectable()
export class AesEncryptionRepository
  implements IEncryptionRepository, OnModuleInit
{
  private algorithm = 'aes-256-gcm';
  private key: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const keyString = this.configService.get<string>('ENCRYPTION_KEY');
    if (!keyString || keyString.length !== 32) {
      throw new InternalServerErrorException(
        'CONFIG ERROR: ENCRYPTION_KEY must be defined and exactly 32 chars.',
      );
    }
    this.key = Buffer.from(keyString);
  }

  encrypt(text: string): string {
    if (!text) return text;

    try {
      // 12 bytes is the IV length GCM is designed for (NIST SP 800-38D); values
      // written earlier with a 16-byte IV still decrypt, because every stored
      // value carries its own IV.
      const iv = crypto.randomBytes(GCM_IV_BYTES);

      const cipher = crypto.createCipheriv(
        this.algorithm,
        this.key,
        iv,
      ) as CipherGCM;

      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag().toString('hex');

      return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    } catch {
      throw new InternalServerErrorException('Encryption failed');
    }
  }

  decrypt(encryptedText: string): string {
    if (!encryptedText || !encryptedText.includes(':')) {
      return encryptedText;
    }

    try {
      const [ivHex, authTagHex, contentHex] = encryptedText.split(':');

      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.key,
        Buffer.from(ivHex, 'hex'),
      ) as DecipherGCM;

      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

      let decrypted = decipher.update(contentHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch {
      console.error('Decryption failed, returning original text');
      return encryptedText;
    }
  }
}
