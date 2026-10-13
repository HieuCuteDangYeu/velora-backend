import { BadRequestException } from '@nestjs/common';
import type { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_MESSAGE_MEDIA_BYTES,
  assertValidMessagePayload,
  resolveAllowedMediaOrigins,
} from './message-payload.validator';

const CDN = 'https://cdn.velora.test';
const ORIGINS = new Set([CDN]);

const payload = (overrides: Record<string, unknown> = {}) =>
  ({
    conversationId: '507f1f77bcf86cd799439011',
    clientMessageId: 'client-1',
    type: 'text',
    signalType: 0,
    content: 'hello',
    ...overrides,
  }) as unknown as CreateMessageDto;

const accepts = (overrides: Record<string, unknown> = {}) =>
  expect(() =>
    assertValidMessagePayload(payload(overrides), ORIGINS),
  ).not.toThrow();
const rejects = (overrides: Record<string, unknown>, message?: string) =>
  expect(() => assertValidMessagePayload(payload(overrides), ORIGINS)).toThrow(
    message ? new BadRequestException(message) : BadRequestException,
  );

describe('assertValidMessagePayload', () => {
  it('accepts an ordinary text message, with and without optional fields', () => {
    accepts();
    accepts({ type: undefined, signalType: undefined });
    accepts({ replyToId: '507f1f77bcf86cd799439012', registrationId: 7 });
    accepts({ replyToId: null, registrationId: null, media: null });
  });

  it('bounds the content length', () => {
    accepts({ content: 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH) });
    rejects(
      { content: 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1) },
      'Message is too long',
    );
    rejects({ content: '' }, 'Content cannot be empty');
    rejects({ content: undefined }, 'Content cannot be empty');
    rejects({ content: { toString: 'x' } }, 'Content cannot be empty');
  });

  it('rejects unknown types and signal types, and malformed identifiers', () => {
    rejects({ type: 'sticker' }, 'Invalid message type');
    rejects({ signalType: 2 }, 'Invalid signalType');
    rejects({ signalType: '0' }, 'Invalid signalType');
    rejects({ conversationId: 'not-an-id' }, 'Invalid conversation ID');
    rejects({ replyToId: 'nope' }, 'Invalid reply target');
    rejects({ replyToId: 12 }, 'Invalid reply target');
    rejects({ clientMessageId: 'c'.repeat(201) }, 'Invalid clientMessageId');
    rejects({ registrationId: 1.5 }, 'Invalid registrationId');
  });

  it('rejects a body that is not an object', () => {
    expect(() => assertValidMessagePayload(null as never, ORIGINS)).toThrow(
      BadRequestException,
    );
    expect(() => assertValidMessagePayload('x' as never, ORIGINS)).toThrow(
      BadRequestException,
    );
  });

  describe('attachments', () => {
    const media = (overrides: Record<string, unknown> = {}) => ({
      fileKey: 'chat-images/u/a.jpg',
      fileUrl: `${CDN}/chat-images/u/a.jpg`,
      thumbnailUrl: `${CDN}/chat-thumbnails/u/a.jpg`,
      mimeType: 'image/jpeg',
      ...overrides,
    });

    it.each(['image', 'video', 'file'])(
      'accepts a %s hosted on the CDN',
      (type) => {
        accepts({ type, media: media() });
        accepts({ type, media: media({ thumbnailUrl: undefined }) });
        accepts({ type, media: media({ thumbnailUrl: null }) });
      },
    );

    it.each([
      ['an external host', 'https://evil.example/pixel.png'],
      ['plain http', 'http://cdn.velora.test/a.jpg'],
      ['a local file', 'file:///var/mobile/a.jpg'],
      ['a lookalike host', 'https://cdn.velora.test.evil.example/a.jpg'],
      ['embedded credentials', 'https://user:pw@cdn.velora.test/a.jpg'],
      ['an unparsable value', 'not a url'],
    ])('rejects %s as fileUrl or thumbnailUrl', (_label, url) => {
      rejects(
        { type: 'image', media: media({ fileUrl: url }) },
        'Invalid media URL',
      );
      rejects(
        { type: 'image', media: media({ thumbnailUrl: url }) },
        'Invalid media thumbnail URL',
      );
    });

    it('rejects a missing or non-string fileUrl and non-object media', () => {
      rejects({ type: 'image', media: media({ fileUrl: undefined }) });
      rejects({ type: 'image', media: media({ fileUrl: 42 }) });
      rejects(
        { type: 'image', media: 'https://cdn.velora.test/a.jpg' },
        'Invalid media',
      );
      rejects({ type: 'image', media: [] }, 'Invalid media');
    });

    it('bounds the size of the attachment object', () => {
      rejects(
        {
          type: 'image',
          media: media({ junk: 'x'.repeat(MAX_MESSAGE_MEDIA_BYTES) }),
        },
        'Media is too large',
      );
    });

    it('leaves reel and other message types unchecked so reel shares keep working', () => {
      const reelMedia = {
        fileUrl: 'https://stream.velora.test/reel/index.m3u8',
        thumbnailUrl: 'file:///var/mobile/local-thumb.jpg',
        reelId: 'r1',
        transcriptSegments: Array.from({ length: 2000 }, (_, index) => ({
          start: index,
          text: 'spoken words '.repeat(5),
        })),
        series: { id: 's1' },
      };

      accepts({ type: 'reel', media: reelMedia });
      accepts({ type: 'call', media: { fileUrl: 'anything' } });
    });

    it('skips the URL check when no CDN origin is configured but still bounds size', () => {
      expect(() =>
        assertValidMessagePayload(
          payload({
            type: 'image',
            media: media({ fileUrl: 'https://x.example/a.jpg' }),
          }),
          null,
        ),
      ).not.toThrow();
      expect(() =>
        assertValidMessagePayload(
          payload({
            type: 'image',
            media: media({ junk: 'x'.repeat(MAX_MESSAGE_MEDIA_BYTES) }),
          }),
          null,
        ),
      ).toThrow(BadRequestException);
    });
  });
});

describe('resolveAllowedMediaOrigins', () => {
  it('derives origins from the CDN domain and the optional extras', () => {
    expect(
      resolveAllowedMediaOrigins({
        R2_PUBLIC_DOMAIN: 'https://cdn.velora-app.me/',
        CHAT_MEDIA_EXTRA_ORIGINS: 'https://media.example.com, , not-a-url',
      }),
    ).toEqual(
      new Set(['https://cdn.velora-app.me', 'https://media.example.com']),
    );
  });

  it('returns null when nothing usable is configured', () => {
    expect(resolveAllowedMediaOrigins({})).toBeNull();
    expect(resolveAllowedMediaOrigins({ R2_PUBLIC_DOMAIN: '   ' })).toBeNull();
  });
});
