import { Message } from '../../domain/entities/message.entity';
import { resolveBotTurnCaption, resolveBotTurnImages } from './bot-turn-image';

const USER = 'user-1';
const image = (overrides: Partial<Message> = {}) =>
  new Message({
    id: 'm1',
    conversationId: 'c1',
    senderId: USER,
    type: 'image',
    content: '[Hình ảnh]',
    createdAt: new Date(),
    media: {
      fileKey: `chat-images/${USER}/abc.png`,
      fileUrl: 'https://cdn.example/chat-images/user-1/abc.png',
      mimeType: 'image/png',
    },
    ...overrides,
  });

describe('bot turn image policy', () => {
  it('returns the sender own upload', () => {
    expect(resolveBotTurnImages(image())).toEqual([
      { fileKey: `chat-images/${USER}/abc.png`, mimeType: 'image/png' },
    ]);
  });

  it('derives the mime type from the key when the client left it out', () => {
    const message = image({
      media: { fileKey: `chat-images/${USER}/abc.jpg`, fileUrl: 'https://x/y' },
    });
    expect(resolveBotTurnImages(message)[0].mimeType).toBe('image/jpeg');
  });

  it('ignores text messages, foreign keys and keyless media', () => {
    expect(resolveBotTurnImages(image({ type: 'text' }))).toEqual([]);
    expect(
      resolveBotTurnImages(
        image({
          media: { fileKey: 'chat-images/other/abc.png', fileUrl: 'x' },
        }),
      ),
    ).toEqual([]);
    expect(
      resolveBotTurnImages(image({ media: { fileUrl: 'https://x/y.png' } })),
    ).toEqual([]);
    expect(resolveBotTurnImages(image({ media: undefined }))).toEqual([]);
  });

  it('uses the typed caption and drops the placeholder', () => {
    expect(resolveBotTurnCaption(image())).toBe('');
    expect(
      resolveBotTurnCaption(image({ content: 'find reels like this' })),
    ).toBe('find reels like this');
    expect(resolveBotTurnCaption(image({ type: 'text', content: 'hi' }))).toBe(
      'hi',
    );
  });
});
