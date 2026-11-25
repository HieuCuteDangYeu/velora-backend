import * as crypto from 'crypto';
import {
  AesEncryptionRepository,
  GCM_IV_BYTES,
} from './aes-encryption.repository';

const KEY = '0123456789abcdef0123456789abcdef';

function repository(): AesEncryptionRepository {
  const repo = new AesEncryptionRepository({
    get: () => KEY,
  } as never);
  repo.onModuleInit();
  return repo;
}

describe('AesEncryptionRepository', () => {
  it('writes a 12-byte IV and reads its own values back', () => {
    const repo = repository();
    const stored = repo.encrypt('xin chào');
    const [ivHex] = stored.split(':');
    expect(Buffer.from(ivHex, 'hex')).toHaveLength(GCM_IV_BYTES);
    expect(repo.decrypt(stored)).toBe('xin chào');
  });

  it('still decrypts values written with the old 16-byte IV', () => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(KEY),
      iv,
    ) as crypto.CipherGCM;
    const content =
      cipher.update('legacy', 'utf8', 'hex') + cipher.final('hex');
    const legacy = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${content}`;
    expect(repository().decrypt(legacy)).toBe('legacy');
  });

  it('uses a fresh IV for every value', () => {
    const repo = repository();
    expect(repo.encrypt('same')).not.toBe(repo.encrypt('same'));
  });

  it('refuses a tampered ciphertext instead of returning altered text', () => {
    const repo = repository();
    const [iv, tag, content] = repo.encrypt('hello').split(':');
    const flipped =
      (parseInt(content[0], 16) ^ 1).toString(16) + content.slice(1);
    const tampered = `${iv}:${tag}:${flipped}`;
    expect(repo.decrypt(tampered)).toBe(tampered);
  });
});
