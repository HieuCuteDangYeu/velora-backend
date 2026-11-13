import type { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { TranslateTranscriptUseCase } from './translate-transcript.use-case';
import type { IStructuredLlmService } from '../../domain/interfaces/structured-llm.service.interface';

describe('TranslateTranscriptUseCase', () => {
  let structuredLlmService: jest.Mocked<IStructuredLlmService>;
  let useCase: TranslateTranscriptUseCase;

  beforeEach(() => {
    structuredLlmService = {
      generateObject: jest.fn(),
    };

    useCase = new TranslateTranscriptUseCase(structuredLlmService);
  });

  it('translates non-English segments into English and Vietnamese', async () => {
    structuredLlmService.generateObject.mockResolvedValueOnce({
      translations: [
        {
          id: 0,
          textEn: 'I am so angry right now!',
          textVi: 'Tôi đang cực kỳ tức giận!',
        },
        {
          id: 1,
          textEn: 'What should we do?',
          textVi: 'Chúng ta nên làm gì đây?',
        },
      ],
    });

    const input: TranscriptionResult = {
      text: '我简直要气炸了! 我们该怎么办?',
      detectedLanguage: 'chinese',
      segments: [
        { id: 0, start: 0, end: 2.5, text: '我简直要气炸了!' },
        { id: 1, start: 2.6, end: 5.0, text: '我们该怎么办?' },
      ],
    };

    const result = await useCase.execute(input);

    expect(result.detectedLanguage).toBe('zh');
    expect(result.textEn).toBe('I am so angry right now! What should we do?');
    expect(result.textVi).toBe(
      'Tôi đang cực kỳ tức giận! Chúng ta nên làm gì đây?',
    );
    expect(result.text).toBe('I am so angry right now! What should we do?');
    expect(result.segments?.[0]).toMatchObject({
      textEn: 'I am so angry right now!',
      textVi: 'Tôi đang cực kỳ tức giận!',
      originalText: '我简直要气炸了!',
    });
  });

  it('translates English segments into Vietnamese while preserving English text', async () => {
    structuredLlmService.generateObject.mockResolvedValueOnce({
      translations: [
        {
          id: 0,
          textEn: 'Hello world.',
          textVi: 'Xin chào thế giới.',
        },
      ],
    });

    const input: TranscriptionResult = {
      text: 'Hello world.',
      detectedLanguage: 'en',
      segments: [{ id: 0, start: 0, end: 1.5, text: 'Hello world.' }],
    };

    const result = await useCase.execute(input);

    expect(result.detectedLanguage).toBe('en');
    expect(result.text).toBe('Hello world.');
    expect(result.textVi).toBe('Xin chào thế giới.');
    expect(result.segments?.[0].textVi).toBe('Xin chào thế giới.');
  });

  it('falls back gracefully on LLM error without failing', async () => {
    structuredLlmService.generateObject.mockRejectedValueOnce(
      new Error('LLM rate limit reached'),
    );

    const input: TranscriptionResult = {
      text: 'Original text.',
      detectedLanguage: 'chinese',
      segments: [{ id: 0, start: 0, end: 1.0, text: 'Original text.' }],
    };

    const result = await useCase.execute(input);

    expect(result.text).toBe('Original text.');
    expect(result.segments?.[0].text).toBe('Original text.');
  });
});
