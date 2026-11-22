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
    const model = this.config.get<string>('MUSE_MODEL')?.trim() || 'muse-chat';
    const timeoutMs = this.timeoutMs();
    const deadline = Date.now() + timeoutMs;
    await this.acquire(deadline);
    try {
      const response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.get<string>('MUSE_API_KEY')?.trim() ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
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
        signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(
          `Muse vision request failed with status ${response.status}`,
        );
      }
      const content = (JSON.parse(raw) as MuseChatPayload).choices?.[0]?.message
        ?.content;
      const parsed = this.parseAnswer(content ?? '');
      return {
        caption: this.requiredText(parsed.caption),
        ...this.optionalOcr(parsed.ocrText),
        objects: this.cleanObjects(parsed.objects),
        provider: 'muse2api',
        model,
        version:
          this.config.get<string>('AI_VISION_MUSE_VERSION')?.trim() ||
          'muse-vision-v1',
      };
    } finally {
      this.release();
    }
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
    throw new Error('Muse vision returned no parsable JSON object');
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
      this.config.get<string>('MUSE_VISION_TIMEOUT_MS') ?? 120_000,
    );
    return Number.isFinite(configured)
      ? Math.min(300_000, Math.max(5_000, configured))
      : 120_000;
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('MUSE_BASE_URL')?.trim() ||
      'http://127.0.0.1:18610/v1'
    ).replace(/\/+$/, '');
  }
}
