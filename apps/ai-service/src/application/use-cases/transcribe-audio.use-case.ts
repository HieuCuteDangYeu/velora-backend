import { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { Inject, Injectable } from '@nestjs/common';
import type { IAudioStorageService } from '../../domain/interfaces/audio-storage.service.interface';
import type {
  ITranscriptionService,
  TranscriptionOptions,
} from '../../domain/interfaces/transcription.service.interface';

@Injectable()
export class TranscribeAudioUseCase {
  constructor(
    @Inject('IAudioStorageService')
    private readonly audioStorageService: IAudioStorageService,
    @Inject('ITranscriptionService')
    private readonly transcriptionService: ITranscriptionService,
  ) {}

  async execute(
    audioKey: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const audioBuffer = await this.audioStorageService.downloadAudio(audioKey);
    return await this.transcriptionService.transcribeAudio(audioBuffer, {
      ...options,
      fileName: audioKey.split('/').pop(),
    });
  }
}
