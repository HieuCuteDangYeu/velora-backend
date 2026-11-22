import type { IVisionService } from '@ai/domain/interfaces/vision.service.interface';
import type { VisualFrameAnalysis } from '@common/ai/interfaces/visual-analysis.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  VISION_SYSTEM_PROMPT,
  VISION_USER_PROMPT,
} from './cloudflare-vision.adapter';

interface MuseChatPayload {
  choices?: Array<{ message?: { content?: string | null } }>;
}

class MuseHttpError extends Error {
  constructor(readonly status: number) {
    super(`Muse vision request failed with status ${status}`);
  }
}

class MuseUnparsableReply extends Error {
  constructor(readonly prose: string) {
    super('Muse vision returned no parsable JSON object');
  }
}

/**
 * Frame analysis over the local muse2api gateway, used as overflow when
 * Cloudflare's daily allocation is spent. The gateway has no JSON mode and
 * levels off at about two parallel chat turns, so calls wait for a slot and the
 * reply is parsed leniently (it can hold a garbled first attempt followed by
 * the complete object).
 */
@Injectable()
export class MuseVisionAdapter implements IVisionService {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly config: ConfigService) {}

  async analyzeImage(input: {
    image: Uint8Array;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  }): Promise<VisualFrameAnalysis> {
    // The gateway is a consumer chat session: it answers 504 under load and sometimes replies with prose
    // instead of JSON. One bad frame fails a whole short-reel index, so a frame gets a few tries inside
    // one budget (the indexer allows 120 s per frame) and, as a last resort, its prose becomes the caption.
    const deadline = Date.now() + this.timeoutMs();
    const maxAttempts = this.maxAttempts();
    let lastError: Error = new Error('Muse vision failed');
    let lastProse = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.attempt(input, deadline);
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof MuseUnparsableReply) lastProse = error.prose;
        else if (!this.retryable(lastError)) throw lastError;
        if (attempt === maxAttempts || Date.now() + 2_000 >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }
    const caption = this.text(lastProse).slice(0, 600);
    if (caption.length >= 20) {
      return this.result({ caption, objects: [] });
    }
    throw lastError;
  }

  private async attempt(
    input: { image: Uint8Array; mimeType: string },
    deadline: number,
  ): Promise<VisualFrameAnalysis> {
    await this.acquire(deadline);
    try {
      const response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.get<string>('MUSE_API_KEY')?.trim() ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model(),
          messages: [
            { role: 'system', content: VISION_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: VISION_USER_PROMPT },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${input.mimeType};base64,${Buffer.from(input.image).toString('base64')}`,
                  },
                },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 700,
          stream: false,
        }),
        signal: AbortSignal.timeout(
          Math.max(500, Math.min(deadline - Date.now(), 60_000)),
        ),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new MuseHttpError(response.status);
      }
      const content =
        (JSON.parse(raw) as MuseChatPayload).choices?.[0]?.message?.content ??
        '';
      const parsed = this.parseAnswer(content);
      return this.result({
        caption: this.requiredText(parsed.caption),
        ...this.optionalOcr(parsed.ocrText),
        objects: this.cleanObjects(parsed.objects),
      });
    } finally {
      this.release();
    }
  }

  private result(fields: {
    caption: string;
    ocrText?: string;
    objects: string[];
  }): VisualFrameAnalysis {
    return {
      ...fields,
      provider: 'muse2api',
      model: this.model(),
      version:
        this.config.get<string>('AI_VISION_MUSE_VERSION')?.trim() ||
        'muse-vision-v1',
    };
  }

  /** 5xx, 429, timeouts, network errors and unparsable replies are worth another try; auth and 4xx are not. */
  private retryable(error: Error): boolean {
    if (error instanceof MuseHttpError)
      return error.status >= 500 || error.status === 429;
    return (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      error.name === 'TypeError' ||
      /timed out waiting/.test(error.message)
    );
  }

  private model(): string {
    return this.config.get<string>('MUSE_MODEL')?.trim() || 'muse-chat';
  }

  private maxAttempts(): number {
    const value = Number(
      this.config.get<string>('MUSE_VISION_MAX_ATTEMPTS') ?? 3,
    );
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 3;
  }

  /** First JSON object in the reply that has a caption. */
  private parseAnswer(content: string): Record<string, unknown> {
    const text = content.replace(/```(?:json)?/gi, '');
    const end = text.lastIndexOf('}');
    for (
      let start = text.indexOf('{');
      start >= 0 && start < end;
      start = text.indexOf('{', start + 1)
    ) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          typeof (parsed as Record<string, unknown>).caption === 'string'
        )
          return parsed as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    throw new MuseUnparsableReply(content);
  }

  private requiredText(value: unknown): string {
    const clean = this.text(value);
    if (!clean) throw new Error('Muse vision returned invalid caption');
    return clean;
  }

  private optionalOcr(value: unknown): { ocrText?: string } {
    const clean = this.text(value);
    return clean ? { ocrText: clean } : {};
  }

  private text(value: unknown): string {
    return typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim().slice(0, 4_000)
      : '';
  }

  private cleanObjects(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.replace(/\s+/g, ' ').trim())
          .filter(Boolean),
      ),
    ].slice(0, 30);
  }

  private async acquire(deadline: number): Promise<void> {
    const limit = Math.max(
      1,
      Number(this.config.get<string>('MUSE_MAX_CONCURRENCY') ?? 2) || 2,
    );
    if (this.active < limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.waiters.splice(this.waiters.indexOf(onSlot), 1);
          reject(new Error('Muse vision timed out waiting for a free slot'));
        },
        Math.max(0, deadline - Date.now()),
      );
      const onSlot = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onSlot);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  private timeoutMs(): number {
    const configured = Number(
      this.config.get<string>('MUSE_VISION_TIMEOUT_MS') ?? 100_000,
    );
    return Number.isFinite(configured)
      ? Math.min(110_000, Math.max(5_000, configured))
      : 100_000;
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('MUSE_BASE_URL')?.trim() ||
      'http://127.0.0.1:18610/v1'
    ).replace(/\/+$/, '');
  }
}
