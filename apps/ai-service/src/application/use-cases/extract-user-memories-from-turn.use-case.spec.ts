import { ExtractUserMemoriesFromTurnUseCase } from './extract-user-memories-from-turn.use-case';

describe('ExtractUserMemoriesFromTurnUseCase', () => {
  const build = () => {
    const extract = jest.fn().mockResolvedValue({ memories: [] });
    const useCase = new ExtractUserMemoriesFromTurnUseCase({ extract });
    return { extract, useCase };
  };
  const at = '2026-01-01T00:00:00Z';

  it('does not use other group members messages as the requester memory source', async () => {
    const { extract, useCase } = build();

    const result = await useCase.execute({
      userId: 'bob',
      conversationId: 'c',
      userMessage: 'I prefer short answers',
      assistantMessage: 'ok',
      memory: {
        recentMessages: [
          {
            role: 'user',
            content: 'I am vegan and I live in Hanoi',
            createdAt: at,
            authorIsRequester: false,
          },
          {
            role: 'user',
            content: 'I like jazz',
            createdAt: at,
            authorIsRequester: true,
          },
        ],
      },
    });

    expect(result.sourceText).toBe('I like jazz\nI prefer short answers');
    expect(extract.mock.calls[0][0].userMessage).not.toContain('vegan');
  });

  it('keeps messages whose authorship is unknown, as before', async () => {
    const { useCase } = build();

    const result = await useCase.execute({
      userId: 'bob',
      conversationId: 'c',
      userMessage: 'now',
      assistantMessage: 'ok',
      memory: {
        recentMessages: [{ role: 'user', content: 'earlier', createdAt: at }],
      },
    });

    expect(result.sourceText).toBe('earlier\nnow');
  });
});
