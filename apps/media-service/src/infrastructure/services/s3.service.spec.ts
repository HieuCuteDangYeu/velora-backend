import { S3Service } from './s3.service';

describe('S3Service Reel presigning', () => {
  it('derives a stable key and signs If-None-Match for Reel renewals', async () => {
    const service = new S3Service({
      getOrThrow: (key: string) =>
        ({
          R2_BUCKET_NAME: 'bucket',
          R2_PUBLIC_DOMAIN: 'https://cdn.example.test',
          R2_ACCOUNT_ID: 'account',
          R2_ACCESS_KEY_ID: 'access-key',
          R2_SECRET_ACCESS_KEY: 'secret-key',
        })[key],
    } as never);

    const first = await service.generatePresignedUrl(
      'user-1',
      'video/mp4',
      'reels',
      '11111111-1111-4111-8111-111111111111',
    );
    const second = await service.generatePresignedUrl(
      'user-1',
      'video/mp4',
      'reels',
      '11111111-1111-4111-8111-111111111111',
    );

    expect(first.key).toBe(
      'reels/user-1/11111111-1111-4111-8111-111111111111.mp4',
    );
    expect(second.key).toBe(first.key);
    const signedUrl = new URL(first.uploadUrl);
    expect(
      signedUrl.searchParams.get('X-Amz-SignedHeaders')?.split(';'),
    ).toEqual(expect.arrayContaining(['host', 'if-none-match']));
    expect(signedUrl.searchParams.get('X-Amz-Content-Sha256')).toBe(
      'UNSIGNED-PAYLOAD',
    );
  });
});
