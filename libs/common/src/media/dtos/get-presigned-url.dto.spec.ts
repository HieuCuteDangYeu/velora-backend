import { GetPresignedUrlSchema } from './get-presigned-url.dto';

describe('GetPresignedUrlSchema Reel intent contract', () => {
  it.each(['video/quicktime', 'video/webm'])(
    'retains the existing Reel MIME contract for %s',
    (fileType) => {
      const result = GetPresignedUrlSchema.safeParse({
        purpose: 'reel',
        fileType,
        publishIntentId: '11111111-1111-4111-8111-111111111111',
      });

      expect(result.success).toBe(true);
    },
  );

  it('keeps modern presigns explicitly in the Reel namespace', () => {
    expect(
      GetPresignedUrlSchema.parse({
        purpose: 'reel',
        fileType: 'video/mp4',
        publishIntentId: '11111111-1111-4111-8111-111111111111',
      }).purpose,
    ).toBe('reel');
  });

  it('accepts publishIntentId only for Reel uploads', () => {
    const result = GetPresignedUrlSchema.safeParse({
      purpose: 'reel',
      fileType: 'video/mp4',
      publishIntentId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.success).toBe(true);
  });

  it('rejects publishIntentId for non-Reel uploads', () => {
    const result = GetPresignedUrlSchema.safeParse({
      purpose: 'chat',
      fileType: 'video/mp4',
      publishIntentId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.success).toBe(false);
  });
});
