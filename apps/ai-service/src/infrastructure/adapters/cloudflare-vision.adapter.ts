import type { IVisionService } from '@ai/domain/interfaces/vision.service.interface';
import type { VisualFrameAnalysis } from '@common/ai/interfaces/visual-analysis.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CloudflareChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | Record<string, unknown> };
  }>;
  error?: { message?: string };
  errors?: Array<{ message?: string } | string>;
}

interface ParsedVisionAnswer {
  caption?: unknown;
  ocrText?: unknown;
  objects?: unknown;
}

@Injectable()
export class CloudflareVisionAdapter implements IVisionService {
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly model: string;
  private readonly version: string;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.getOrThrow<string>(
      'CLOUDFLARE_ACCOUNT_ID',
    );
    this.apiToken = this.configService.getOrThrow<string>(
      'CLOUDFLARE_API_TOKEN',
    );
    this.model = this.configService.getOrThrow<string>('AI_VISION_MODEL');
    this.version = this.configService.getOrThrow<string>('AI_VISION_VERSION');
    this.timeoutMs = this.positiveInt('AI_VISION_TIMEOUT_MS', 120_000);
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  }

  async analyzeImage(input: {
    image: Uint8Array;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  }): Promise<VisualFrameAnalysis> {
    const imageBase64 = Buffer.from(input.image).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'Analyze only the supplied single frame. Do not infer speech, identity, intent, emotion, motion, hidden text, or events outside this sampled timestamp. Return only a JSON object with exactly these keys: caption (a non-empty factual string), ocrText (a string containing only clearly readable text and empty when it cannot be read), and objects (an array of short grounded strings). When multiple people are visible, prefix person-specific observations with a stable label such as "subject 1:" or "subject 2:"; use "unassigned:" when an attribute cannot be linked to one subject. Never turn an unassigned attribute into a claim about every person.',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Set caption to a factual description of visible content, ocrText to only clearly readable text, and objects to important visible objects or UI elements. Preserve visible numbers and code exactly; omit uncertain text. Do not say that no text exists merely because OCR is empty.',
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${input.mimeType};base64,${imageBase64}`,
                  },
                },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 700,
          stream: false,
          response_format: {
            type: 'json_object',
          },
        }),
      });

      const rawBody = await response.text();
      const payload = this.parseEnvelope(rawBody);
      if (!response.ok) {
        throw new Error(
          `Cloudflare Workers AI vision request failed with status ${response.status}: ${this.extractErrorMessage(payload, rawBody)}`,
        );
      }

      const content = payload.choices?.[0]?.message?.content;
      const parsed = this.parseVisionAnswer(content);
      const caption = this.requiredText(parsed.caption, 'caption', 4_000);
      const ocrText = this.optionalText(parsed.ocrText, 4_000);
      const objects = this.cleanObjects(parsed.objects);

      return {
        caption,
        ...(ocrText ? { ocrText } : {}),
        objects,
        provider: 'cloudflare-workers-ai',
        model: this.model,
        version: this.version,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
      'cf-aig-skip-cache': 'true',
    };
    if (this.boolean('CLOUDFLARE_AI_GATEWAY_ENABLED', true)) {
      headers['cf-aig-gateway-id'] = this.configService.getOrThrow<string>(
        'CLOUDFLARE_AI_GATEWAY_ID',
      );
    }
    return headers;
  }

  private parseEnvelope(rawBody: string): CloudflareChatCompletionResponse {
    try {
      return JSON.parse(rawBody) as CloudflareChatCompletionResponse;
    } catch {
      return {};
    }
  }

  private parseVisionAnswer(
    content: string | Record<string, unknown> | undefined,
  ): ParsedVisionAnswer {
    if (!content) throw new Error('Cloudflare vision returned empty content');
    if (typeof content === 'object') return content;
    try {
      const parsed = JSON.parse(content.trim()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed;
    } catch {
      throw new Error('Cloudflare vision returned invalid structured JSON');
    }
  }

  private requiredText(
    value: unknown,
    field: string,
    maxLength: number,
  ): string {
    const clean = this.optionalText(value, maxLength);
    if (!clean) throw new Error(`Cloudflare vision returned invalid ${field}`);
    return clean;
  }

  private optionalText(value: unknown, maxLength: number): string {
    return typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
      : '';
  }

  private cleanObjects(value: unknown): string[] {
    if (!Array.isArray(value))
      throw new Error('Cloudflare vision returned invalid objects');
    const objects = value.filter(
      (item): item is string => typeof item === 'string',
    );
    if (objects.length !== value.length)
      throw new Error('Cloudflare vision returned invalid objects');
    return [
      ...new Set(
        objects.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean),
      ),
    ].slice(0, 30);
  }

  private extractErrorMessage(
    payload: CloudflareChatCompletionResponse,
    rawBody: string,
  ): string {
    const messages = (payload.errors ?? [])
      .map((error) => (typeof error === 'string' ? error : error.message || ''))
      .filter(Boolean);
    return (
      payload.error?.message ||
      messages.join('; ') ||
      rawBody.trim() ||
      'Unknown Cloudflare Workers AI error'
    );
  }

  private boolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string>(key)?.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  private positiveInt(key: string, max: number): number {
    const value = Number(this.configService.getOrThrow<string>(key));
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  }
}
