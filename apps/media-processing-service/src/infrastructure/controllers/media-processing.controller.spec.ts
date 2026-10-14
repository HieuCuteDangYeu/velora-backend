import { MediaProcessingController } from './media-processing.controller';

const buildDelivery = () => {
  const channel = {
    ack: jest.fn(),
    nack: jest.fn(),
  };
  const message = {
    fields: { redelivered: false },
    properties: { headers: {}, timestamp: Date.now() },
  };
  const context = {
    getChannelRef: () => channel,
    getMessage: () => message,
  };

  return { channel, message, context };
};

const buildJob = (mediaKey: string, hlsMasterKey?: string) => ({
  jobId: 'job-1',
  reelId: 'reel-1',
  userId: 'user-1',
  mediaKey,
  mediaAttemptId: 'attempt-1',
  expectedLengthClass: 'SHORT' as const,
  tags: [],
  ...(hlsMasterKey
    ? { sourceMode: 'EXISTING_HLS' as const, hlsMasterKey }
    : {}),
  createdAt: new Date().toISOString(),
  schemaVersion: 1 as const,
});

const buildController = () => {
  const execute = jest.fn().mockResolvedValue({ status: 'COMPLETED' });
  const publishRetry = jest.fn();
  const controller = new MediaProcessingController(
    { execute } as never,
    { execute: jest.fn() } as never,
    { publishRetry },
  );

  return { controller, execute, publishRetry };
};

describe('MediaProcessingController Reel media-key compatibility', () => {
  it.each([
    {
      mediaKey: 'chat-videos/user-1/source.quicktime',
      hlsMasterKey: 'chat-videos/user-1/source/master.m3u8',
    },
    {
      mediaKey: 'reels/user-1/source.webm',
      hlsMasterKey: 'reels/user-1/source/master.m3u8',
    },
  ])('accepts owned source and HLS keys', async (keys) => {
    const harness = buildController();
    const delivery = buildDelivery();

    await harness.controller.handleReelMediaJob(
      buildJob(keys.mediaKey, keys.hlsMasterKey),
      delivery.context as never,
    );

    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaKey: keys.mediaKey,
        hlsMasterKey: keys.hlsMasterKey,
        userId: 'user-1',
      }),
    );
    expect(delivery.channel.ack).toHaveBeenCalledWith(delivery.message);
    expect(delivery.channel.nack).not.toHaveBeenCalled();
  });

  it.each([
    'chat-videos/user-2/source.mp4',
    'chat-videos/user-1/../user-2/source.mp4',
    'chat-videos/user-1\\source.mp4',
  ])('rejects an unsafe or foreign source key: %s', async (mediaKey) => {
    const harness = buildController();
    const delivery = buildDelivery();

    await harness.controller.handleReelMediaJob(
      buildJob(mediaKey),
      delivery.context as never,
    );

    expect(harness.execute).not.toHaveBeenCalled();
    expect(delivery.channel.ack).not.toHaveBeenCalled();
    expect(delivery.channel.nack).toHaveBeenCalledWith(
      delivery.message,
      false,
      false,
    );
  });

  it('rejects an unsafe or foreign HLS key while retaining the source key', async () => {
    const harness = buildController();
    const delivery = buildDelivery();

    await harness.controller.handleReelMediaJob(
      buildJob(
        'chat-videos/user-1/source.mp4',
        'chat-videos/user-2/source/master.m3u8',
      ),
      delivery.context as never,
    );

    expect(harness.execute).not.toHaveBeenCalled();
    expect(delivery.channel.nack).toHaveBeenCalledWith(
      delivery.message,
      false,
      false,
    );
  });

  it('accepts a legacy source on the pending reel.created compatibility path', async () => {
    const harness = buildController();
    const delivery = buildDelivery();

    await harness.controller.handleReelCreated(
      {
        reelId: 'reel-1',
        mediaKey: 'chat-videos/user-1/source.webm',
        userId: 'user-1',
      },
      delivery.context as never,
    );

    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaKey: 'chat-videos/user-1/source.webm',
        userId: 'user-1',
      }),
    );
    expect(delivery.channel.ack).toHaveBeenCalledWith(delivery.message);
  });
  it('routes a legacy imported evidence job to the stored canonical HLS key', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    const hlsMasterKey = `reels/${id}/master.m3u8`;
    const harness = buildController();
    const delivery = buildDelivery();
    await harness.controller.handleReelMediaJob(
      {
        ...buildJob('https://external.example/original.mp4', hlsMasterKey),
        reelId: id,
      },
      delivery.context as never,
    );
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaKey: hlsMasterKey,
        hlsMasterKey,
        reelId: id,
      }),
    );
    expect(delivery.channel.ack).toHaveBeenCalled();
    expect(delivery.channel.nack).not.toHaveBeenCalled();
  });
});
