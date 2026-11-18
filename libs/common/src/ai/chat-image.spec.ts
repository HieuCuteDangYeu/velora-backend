import {
  extractChatImageCaption,
  isChatImageKeyOwnedBy,
  isChatImageMimeType,
} from './chat-image';

describe('chat image helpers', () => {
  const user = '11111111-1111-4111-8111-111111111111';

  it('accepts only the requester own chat upload keys', () => {
    expect(
      isChatImageKeyOwnedBy(user, `chat-images/${user}/0a1b-22.jpeg`),
    ).toBe(true);
    expect(
      isChatImageKeyOwnedBy(user, `chat-images/${user}/0a1b-22.webp`),
    ).toBe(true);
  });

  it.each([
    ['another user', 'chat-images/someone-else/abc.jpeg'],
    ['another folder', `reels/${user}/abc.jpeg`],
    ['a nested path', `chat-images/${user}/x/abc.jpeg`],
    ['path traversal', `chat-images/${user}/../abc.jpeg`],
    ['a non-image extension', `chat-images/${user}/abc.mp4`],
    ['a user-id prefix match', `chat-images/${user}9/abc.jpeg`],
    ['an empty name', `chat-images/${user}/.jpeg`],
  ])('rejects %s', (_label, key) => {
    expect(isChatImageKeyOwnedBy(user, key)).toBe(false);
  });

  it('rejects an empty or slash-bearing user id', () => {
    expect(isChatImageKeyOwnedBy('', 'chat-images//abc.jpeg')).toBe(false);
    expect(isChatImageKeyOwnedBy('a/b', 'chat-images/a/b/abc.jpeg')).toBe(
      false,
    );
  });

  it('knows the supported mime types', () => {
    expect(isChatImageMimeType('image/png')).toBe(true);
    expect(isChatImageMimeType('image/gif')).toBe(false);
    expect(isChatImageMimeType(undefined)).toBe(false);
  });

  it('treats the composer placeholder as no caption', () => {
    expect(extractChatImageCaption('[Hình ảnh]')).toBe('');
    expect(extractChatImageCaption('  ')).toBe('');
    expect(extractChatImageCaption(undefined)).toBe('');
    expect(extractChatImageCaption(' find reels like this ')).toBe(
      'find reels like this',
    );
  });
});
