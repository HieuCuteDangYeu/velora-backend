import type { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { TranscribeAudioUseCase } from './transcribe-audio.use-case';
import type { IAudioStorageService } from '../../domain/interfaces/audio-storage.service.interface';
import type { ITranscriptionService } from '../../domain/interfaces/transcription.service.interface';
import type { TranslateTranscriptUseCase } from './translate-transcript.use-case';

describe('TranscribeAudioUseCase', () => {
  let audioStorageService: jest.Mocked<IAudioStorageService>;
  let transcriptionService: jest.Mocked<ITranscriptionService>;
  let translateTranscript: jest.Mocked<TranslateTranscriptUseCase>;
  let useCase: TranscribeAudioUseCase;

  beforeEach(() => {
    audioStorageService = {
      downloadAudio: jest.fn().mockResolvedValue(Buffer.from('dummy audio')),
    };

    transcriptionService = {
      transcribeAudio: jest.fn(),
    };

    translateTranscript = {
      execute: jest.fn(),
    } as unknown as jest.Mocked<TranslateTranscriptUseCase>;

    useCase = new TranscribeAudioUseCase(
      audioStorageService,
      transcriptionService,
      translateTranscript,
    );
  });

  it('downloads audio, transcribes it, and passes result to translateTranscript', async () => {
    const rawResult: TranscriptionResult = {
      text: '你好',
      detectedLanguage: 'zh',
      segments: [{ id: 0, start: 0, end: 1, text: '你好' }],
    };
    const translatedResult: TranscriptionResult = {
      text: 'Hello',
      textEn: 'Hello',
      textVi: 'Xin chào',
      detectedLanguage: 'zh',
      segments: [
        {
          id: 0,
          start: 0,
          end: 1,
          text: 'Hello',
          textEn: 'Hello',
          textVi: 'Xin chào',
        },
      ],
    };

    transcriptionService.transcribeAudio.mockResolvedValueOnce(rawResult);
    translateTranscript.execute.mockResolvedValueOnce(translatedResult);

    const result = await useCase.execute('reels/1/audio/0.wav');

    expect(audioStorageService.downloadAudio).toHaveBeenCalledWith(
      'reels/1/audio/0.wav',
    );
    expect(transcriptionService.transcribeAudio).toHaveBeenCalledWith(
      Buffer.from('dummy audio'),
      undefined,
    );
    expect(translateTranscript.execute).toHaveBeenCalledWith(rawResult);
    expect(result).toBe(translatedResult);
  });
});
