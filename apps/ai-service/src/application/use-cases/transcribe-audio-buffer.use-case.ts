import { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ITranscriptionService,
  TranscriptionOptions,
} from '../../domain/interfaces/transcription.service.interface';

@Injectable()
export class TranscribeAudioBufferUseCase {
  constructor(
    @Inject('ITranscriptionService')
    private readonly transcriptionService: ITranscriptionService,
  ) {}

  async execute(
    audioBase64: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    return await this.transcriptionService.transcribeAudio(
      audioBuffer,
      options,
    );
  }
}
