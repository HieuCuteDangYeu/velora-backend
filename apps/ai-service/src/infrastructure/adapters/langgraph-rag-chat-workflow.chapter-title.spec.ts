import { LangGraphRagChatWorkflowAdapter } from './langgraph-rag-chat-workflow.adapter';

type ChapterResolver = {
  resolveChapterQuestion(
    message: string,
    accessibleReelIds: string[],
  ): Promise<string | undefined>;
};

const description = '0:00 Intro\n1:05 Les ingrédients\n3:20 La cuisson';
const question =
  'What is covered in the part of the video titled "Les ingredients"?';

function build(
  flags: Record<string, string>,
  getReelDocument: jest.Mock,
): { resolver: ChapterResolver; logger: { warn: jest.Mock } } {
  const resolver = Object.create(
    LangGraphRagChatWorkflowAdapter.prototype,
  ) as ChapterResolver & Record<string, unknown>;
  const logger = { debug: jest.fn(), warn: jest.fn() };
  resolver.config = { get: (key: string) => flags[key] };
  resolver.reelSemanticIndex = { getReelDocument };
  resolver.logger = logger;
  return { resolver, logger };
}

describe('LangGraphRagChatWorkflowAdapter chapter title resolution', () => {
  const on = { AI_CHAPTER_TITLE_RESOLUTION: 'true' };
  const document = { description, sourceDurationMs: 400_000 };

  it('rewrites a question naming a chapter into that chapter time range', async () => {
    const get = jest.fn().mockResolvedValue(document);
    const { resolver } = build(on, get);
    await expect(
      resolver.resolveChapterQuestion(question, ['reel-1']),
    ).resolves.toBe(
      'Summarize what is said from 65 to 200 seconds in the video, in the part titled "Les ingrédients".',
    );
    expect(get).toHaveBeenCalledWith('reel-1');
  });

  it('does nothing unless switched on, without calling the index', async () => {
    const get = jest.fn().mockResolvedValue(document);
    const { resolver } = build({}, get);
    await expect(
      resolver.resolveChapterQuestion(question, ['reel-1']),
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('leaves the question alone for several shared reels or no match', async () => {
    const get = jest.fn().mockResolvedValue(document);
    const { resolver } = build(on, get);
    await expect(
      resolver.resolveChapterQuestion(question, ['reel-1', 'reel-2']),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveChapterQuestion('How hot is the oven?', ['reel-1']),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveChapterQuestion(question, []),
    ).resolves.toBeUndefined();
  });

  it('leaves the question alone, and warns, when the lookup fails or the description has no chapters', async () => {
    const failing = build(on, jest.fn().mockRejectedValue(new Error('down')));
    await expect(
      failing.resolver.resolveChapterQuestion(question, ['reel-1']),
    ).resolves.toBeUndefined();
    expect(failing.logger.warn).toHaveBeenCalled();
    const plain = build(
      on,
      jest.fn().mockResolvedValue({ description: 'Just a recipe.' }),
    );
    await expect(
      plain.resolver.resolveChapterQuestion(question, ['reel-1']),
    ).resolves.toBeUndefined();
  });
});
