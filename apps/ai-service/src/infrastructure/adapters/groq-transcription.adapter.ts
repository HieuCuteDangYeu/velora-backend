import type { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ITranscriptionService,
  TranscriptionOptions,
} from '@ai/domain/interfaces/transcription.service.interface';

interface GroqTranscriptionPayload {
  text?: string;
  segments?: unknown[];
  words?: unknown[];
}

@Injectable()
export class GroqTranscriptionAdapter implements ITranscriptionService {
  constructor(private readonly config: ConfigService) {}

  async transcribeAudio(
    audioBuffer: Buffer,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const model = this.config.getOrThrow<string>('AI_TRANSCRIPTION_MODEL');
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' }),
      'audio.wav',
    );
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    const language = this.config
      .get<string>('AI_TRANSCRIPTION_LANGUAGE')
      ?.trim();
    if (language) form.append('language', language);
    if (options?.initialPrompt?.trim())
      form.append('prompt', options.initialPrompt.trim().slice(0, 2_000));

    const controller = new AbortController();
    const timeoutMs = this.positiveInt('AI_TRANSCRIPTION_TIMEOUT_MS', 120_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(`${this.baseUrl()}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.getOrThrow<string>('GROQ_API_KEY')}`,
        },
        body: form,
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: GroqTranscriptionPayload = {};
      try {
        payload = JSON.parse(raw) as GroqTranscriptionPayload;
      } catch {
        payload = {};
      }
      if (!response.ok)
        throw new Error(
          `Groq transcription failed with status ${response.status}: ${raw.slice(0, 500)}`,
        );
      const text = payload.text?.trim() ?? '';
      return {
        text,
        segments:
          this.normalizeWords(payload.words) ??
          this.normalizeSegments(payload.segments),
        wordCount: text ? text.split(/\s+/u).length : 0,
        provider: 'groq',
        model,
        version:
          this.config.get<string>('AI_TRANSCRIPTION_VERSION')?.trim() ||
          'groq-whisper-v1',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private normalizeWords(
    value: unknown,
  ):
    | Array<{ start: number; end: number; text: string; id?: number }>
    | undefined {
    if (!Array.isArray(value)) return undefined;
    const words = value
      .map((item, index) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const start = Number(record['start']);
        const end = Number(record['end']);
        const text =
          typeof record['word'] === 'string'
            ? record['word'].trim()
            : typeof record['text'] === 'string'
              ? record['text'].trim()
              : '';
        if (!Number.isFinite(start) || !Number.isFinite(end) || !text)
          return null;
        return { id: index, start, end, text };
      })
      .filter(
        (
          item,
        ): item is { start: number; end: number; text: string; id: number } =>
          Boolean(item),
      );
    return words.length > 0 ? words : undefined;
  }

  private normalizeSegments(
    value: unknown,
  ):
    | Array<{ start: number; end: number; text: string; id?: number }>
    | undefined {
    if (!Array.isArray(value)) return undefined;
    const segments = value
      .map((item, index) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const start = Number(record['start']);
        const end = Number(record['end']);
        const text =
          typeof record['text'] === 'string' ? record['text'].trim() : '';
        if (!Number.isFinite(start) || !Number.isFinite(end) || !text)
          return null;
        return {
          id: Number.isInteger(record['id']) ? Number(record['id']) : index,
          start,
          end,
          text,
        };
      })
      .filter(
        (
          item,
        ): item is { start: number; end: number; text: string; id: number } =>
          Boolean(item),
      );
    return segments.length > 0 ? segments : undefined;
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('GROQ_BASE_URL')?.trim() ||
      'https://api.groq.com/openai/v1'
    ).replace(/\/+$/, '');
  }

  private positiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isInteger(value) && value > 0
      ? Math.min(value, 600_000)
      : fallback;
  }
}
