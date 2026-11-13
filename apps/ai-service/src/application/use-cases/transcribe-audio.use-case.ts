import { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { IAudioStorageService } from '../../domain/interfaces/audio-storage.service.interface';
import type {
  ITranscriptionService,
  TranscriptionOptions,
} from '../../domain/interfaces/transcription.service.interface';
import { TranslateTranscriptUseCase } from './translate-transcript.use-case';

@Injectable()
export class TranscribeAudioUseCase {
  constructor(
    @Inject('IAudioStorageService')
    private readonly audioStorageService: IAudioStorageService,
    @Inject('ITranscriptionService')
    private readonly transcriptionService: ITranscriptionService,
    @Optional()
    private readonly translateTranscript?: TranslateTranscriptUseCase,
  ) {}

  async execute(
    audioKey: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const audioBuffer = await this.audioStorageService.downloadAudio(audioKey);
    const result = await this.transcriptionService.transcribeAudio(
      audioBuffer,
      options,
    );
    if (this.translateTranscript) {
      return await this.translateTranscript.execute(result);
    }
    return result;
  }
}
