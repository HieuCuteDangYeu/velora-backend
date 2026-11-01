import {
  CreateReelCommentUseCase,
  DeleteReelCommentUseCase,
  ListReelCommentsUseCase,
  UpdateReelCommentUseCase,
} from './reel-comments.use-cases';

describe('Reel comments access and operations', () => {
  const getReel = { execute: jest.fn() };
  const reels = { findById: jest.fn() };
  const comments = {
    find: jest.fn(),
    create: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  beforeEach(() => {
    jest.resetAllMocks();
    getReel.execute.mockResolvedValue({
      userId: 'owner',
      mediaStatus: 'COMPLETED',
    });
  });
  it('requires current access and completed media before creation', async () => {
    const useCase = new CreateReelCommentUseCase(
      getReel as any,
      comments as any,
    );
    const input = {
      reelId: 'r',
      authorId: 'a',
      parentId: null,
      text: 'hello',
      clientRequestId: 'key',
    };
    getReel.execute
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ mediaStatus: 'PENDING' });
    await expect(useCase.execute(input)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(useCase.execute(input)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(comments.create).not.toHaveBeenCalled();
    await useCase.execute(input);
    expect(comments.create).toHaveBeenCalledWith(input);
  });
  it('rejects nested reply listing and checks access for editing', async () => {
    comments.find.mockResolvedValue({ parentId: 'root' });
    const list = new ListReelCommentsUseCase(getReel as any, comments as any);
    await expect(
      list.execute({
        reelId: 'r',
        viewerId: 'a',
        parentId: 'reply',
        limit: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    getReel.execute.mockResolvedValue(null);
    const update = new UpdateReelCommentUseCase(
      getReel as any,
      comments as any,
    );
    await expect(
      update.execute({ reelId: 'r', authorId: 'a', id: 'c', text: 'x' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(comments.update).not.toHaveBeenCalled();
  });
  it('allows the author to delete after losing access, but not another user', async () => {
    comments.find.mockResolvedValue({ authorId: 'a' });
    reels.findById.mockResolvedValue({ userId: 'owner' });
    comments.delete.mockResolvedValue(true);
    getReel.execute.mockResolvedValue(null);
    const useCase = new DeleteReelCommentUseCase(
      getReel as any,
      reels as any,
      comments as any,
    );
    await expect(
      useCase.execute({ reelId: 'r', id: 'c', actorId: 'a' }),
    ).resolves.toEqual({ success: true });
    expect(getReel.execute).not.toHaveBeenCalled();
    await expect(
      useCase.execute({ reelId: 'r', id: 'c', actorId: 'other' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
