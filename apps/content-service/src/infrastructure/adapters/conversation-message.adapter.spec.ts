import type { Reel } from '@content/domain/entities/reel.entity';
import type { IUserService } from '@content/domain/interfaces/user-service.interface';
import { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { ConversationMessageAdapter } from './conversation-message.adapter';

describe('ConversationMessageAdapter', () => {
  it('includes reel geometry when creating a reel message', async () => {
    const send = jest.fn().mockReturnValue(
      of({
        message: {
          id: 'message-1',
          conversationId: 'conversation-1',
          senderId: 'user-1',
          content: 'Shared a reel',
          type: 'reel',
          createdAt: '2026-09-19T00:00:00.000Z',
        },
      }),
    );
    const conversationClient = { send } as unknown as ClientProxy;
    const userService = {
      findPublicUsersByIds: jest.fn().mockResolvedValue([]),
    } as unknown as IUserService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('https://cdn.velora.test'),
    } as unknown as ConfigService;
    const adapter = new ConversationMessageAdapter(
      conversationClient,
      userService,
      configService,
    );

    await adapter.createReelMessage({
      conversationId: 'conversation-1',
      senderId: 'user-1',
      reel: {
        id: 'reel-1',
        userId: 'owner-1',
        mediaKey: 'reels/reel-1/source.mp4',
        title: 'Landscape reel',
        tags: [],
        sourceEffectiveWidth: 1920,
        sourceEffectiveHeight: 1080,
        sourceOrientation: 'LANDSCAPE',
        sourceAspectRatio: 1.7778,
        sourceLengthClass: 'LONG',
      } as Reel,
    });

    expect(send).toHaveBeenCalledWith(
      'create_message',
      expect.objectContaining({
        media: expect.objectContaining({
          reelId: 'reel-1',
          width: 1920,
          height: 1080,
          reelSourceOrientation: 'LANDSCAPE',
          reelSourceAspectRatio: 1.7778,
          reelPlaybackPresentation: 'FIT_WITH_LETTERBOX',
        }),
      }),
    );
  });
});
