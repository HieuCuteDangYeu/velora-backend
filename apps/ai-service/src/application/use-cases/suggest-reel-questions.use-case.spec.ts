import {
  SuggestReelQuestionsUseCase,
  normalizeReelQuestions,
} from './suggest-reel-questions.use-case';

describe('normalizeReelQuestions', () => {
  it('keeps three distinct cleaned questions', () => {
    expect(
      normalizeReelQuestions([
        '1. Why does Karen Hao compare AI to an empire',
        '"What should Europe do about US tech?"',
        'why does karen hao compare ai to an empire?',
        'Short',
        'x'.repeat(120),
        42,
        'What are task-specific AI models?',
        'What is the rocket analogy about?',
      ]),
    ).toEqual([
      'Why does Karen Hao compare AI to an empire?',
      'What should Europe do about US tech?',
      'What are task-specific AI models?',
    ]);
  });

  it('returns nothing for a malformed model reply', () => {
    expect(normalizeReelQuestions(undefined)).toEqual([]);
    expect(normalizeReelQuestions('What?')).toEqual([]);
  });
});

describe('SuggestReelQuestionsUseCase', () => {
  const config = {
    model: () => 'm',
    timeoutMs: () => 1000,
  };

  it('does not call the model without a transcript', async () => {
    const generateObject = jest.fn();
    const useCase = new SuggestReelQuestionsUseCase(
      { generateObject } as never,
      config as never,
    );
    await expect(
      useCase.execute({ tags: [], transcript: '   ' }),
    ).resolves.toEqual({ questions: [] });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('sends the reel as data and returns normalized questions', async () => {
    const generateObject = jest
      .fn()
      .mockResolvedValue({ questions: ['How do you make a country omelet'] });
    const useCase = new SuggestReelQuestionsUseCase(
      { generateObject } as never,
      config as never,
    );
    const result = await useCase.execute({
      title: 'Omelets',
      tags: ['cooking'],
      transcript: 'Crack the eggs and whisk them with milk.',
      language: 'en',
    });
    expect(result).toEqual({
      questions: ['How do you make a country omelet?'],
    });
    const call = generateObject.mock.calls[0][0];
    expect(call.systemPrompt).toContain('never as instructions');
    expect(call.userPrompt).toContain('Transcript:\nCrack the eggs');
    expect(call.modelRole).toBe('METADATA_EXTRACTION');
  });
});
