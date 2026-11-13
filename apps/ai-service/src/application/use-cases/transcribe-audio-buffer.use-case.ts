import { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
  ITranscriptionService,
  TranscriptionOptions,
} from '../../domain/interfaces/transcription.service.interface';
import { TranslateTranscriptUseCase } from './translate-transcript.use-case';

@Injectable()
export class TranscribeAudioBufferUseCase {
  constructor(
    @Inject('ITranscriptionService')
    private readonly transcriptionService: ITranscriptionService,
    @Optional()
    private readonly translateTranscript?: TranslateTranscriptUseCase,
  ) {}

  async execute(
    audioBase64: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
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
