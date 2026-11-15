import type { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { TranscribeAudioUseCase } from './transcribe-audio.use-case';
import type { IAudioStorageService } from '../../domain/interfaces/audio-storage.service.interface';
import type { ITranscriptionService } from '../../domain/interfaces/transcription.service.interface';

describe('TranscribeAudioUseCase', () => {
  it('downloads the audio and transcribes it under its own file name', async () => {
    const audioStorageService: jest.Mocked<IAudioStorageService> = {
      downloadAudio: jest.fn().mockResolvedValue(Buffer.from('dummy audio')),
    };
    const result: TranscriptionResult = {
      text: '你好',
      detectedLanguage: 'zh',
      segments: [{ id: 0, start: 0, end: 1, text: '你好' }],
    };
    const transcriptionService: jest.Mocked<ITranscriptionService> = {
      transcribeAudio: jest.fn().mockResolvedValue(result),
    };

    const output = await new TranscribeAudioUseCase(
      audioStorageService,
      transcriptionService,
    ).execute('reels/1/audio/0.ogg');

    expect(audioStorageService.downloadAudio).toHaveBeenCalledWith(
      'reels/1/audio/0.ogg',
    );
    expect(transcriptionService.transcribeAudio).toHaveBeenCalledWith(
      Buffer.from('dummy audio'),
      { fileName: '0.ogg' },
    );
    expect(output).toBe(result);
  });
});
