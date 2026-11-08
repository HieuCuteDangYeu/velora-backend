import type { IVisionService } from '@ai/domain/interfaces/vision.service.interface';
import { GroqKeyPool } from '@ai/infrastructure/services/groq-key-pool.service';
import type { VisualFrameAnalysis } from '@common/ai/interfaces/visual-analysis.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const DEFAULT_VERSION = 'groq-qwen3.8-27b-vision-2026-11';

// Same instructions as the Cloudflare adapter so scene evidence stays comparable across providers.
const SYSTEM_PROMPT =
  'Analyze only the supplied single frame. Do not infer speech, identity, intent, emotion, motion, hidden text, or events outside this sampled timestamp. Return only a JSON object with exactly these keys: caption (a non-empty factual string), ocrText (a string containing only clearly readable text and empty when it cannot be read), and objects (an array of short grounded strings). When multiple people are visible, prefix person-specific observations with a stable label such as "subject 1:" or "subject 2:"; use "unassigned:" when an attribute cannot be linked to one subject. Never turn an unassigned attribute into a claim about every person.';
const USER_PROMPT =
  'Set caption to a factual description of visible content, ocrText to only clearly readable text, and objects to important visible objects or UI elements. Preserve visible numbers and code exactly; omit uncertain text. Do not say that no text exists merely because OCR is empty.';

interface GroqChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

/**
 * Frame analysis on a Groq vision model. It rotates its own key list
 * (GROQ_VISION_API_KEYS) so paid keys in the shared GROQ_API_KEYS pool can be
 * kept out of vision traffic; unset, it falls back to GROQ_API_KEYS.
 */
@Injectable()
export class GroqVisionAdapter implements IVisionService {
  private readonly keyPool: GroqKeyPool;
  private readonly model: string;
  private readonly version: string;

  constructor(private readonly config: ConfigService) {
    this.model =
      config.get<string>('GROQ_VISION_MODEL')?.trim() || DEFAULT_MODEL;
    this.version =
      config.get<string>('GROQ_VISION_VERSION')?.trim() || DEFAULT_VERSION;
    const visionKeys = config.get<string>('GROQ_VISION_API_KEYS')?.trim();
    const scoped = {
      get: (key: string): unknown =>
        key === 'GROQ_API_KEYS' && visionKeys ? visionKeys : config.get(key),
      getOrThrow: (key: string): unknown =>
        key === 'GROQ_API_KEYS' && visionKeys
          ? visionKeys
          : config.getOrThrow(key),
    } as unknown as ConfigService;
    this.keyPool = new GroqKeyPool(scoped);
    this.keyPool.onModuleInit();
  }

  async analyzeImage(input: {
    image: Uint8Array;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  }): Promise<VisualFrameAnalysis> {
    const imageBase64 = Buffer.from(input.image).toString('base64');
    const timeoutMs = this.timeoutMs();
    // Each attempt gets its own budget so one slow response cannot starve the retry on another key.
    const attempts = Math.min(3, Math.max(1, this.keyPool.size));
    let rateLimited = false;
    let lastMessage = 'no capacity';

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Throws GroqKeyPoolExhaustedError (message matches the rate-limit check) when every key is spent.
      const { key, index } = await this.keyPool.acquireAsync(5_000, this.model);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      try {
        const response = await fetch(`${this.baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'text', text: USER_PROMPT },
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
            max_completion_tokens: 700,
            response_format: { type: 'json_object' },
          }),
        });
        const raw = await response.text();
        if (response.status === 429) {
          this.keyPool.reportRateLimited(
            index,
            response.headers,
            raw,
            this.model,
          );
          rateLimited = true;
          lastMessage = this.errorMessage(raw);
          continue;
        }
        if (response.status >= 500) {
          this.keyPool.reportTransientFailure(index, this.model);
          rateLimited = false;
          lastMessage = `status ${response.status}: ${this.errorMessage(raw)}`;
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Groq vision request failed with status ${response.status}: ${this.errorMessage(raw)}`,
          );
        }
        this.keyPool.reportSuccess(index, response.headers, this.model);
        return this.toAnalysis(raw);
      } catch (error: unknown) {
        const timedOut = controller.signal.aborted;
        const network = error instanceof TypeError || timedOut;
        if (!network) throw error;
        // A timeout or dropped connection is transient: try the next key.
        this.keyPool.reportTransientFailure(index, this.model);
        rateLimited = false;
        lastMessage = timedOut
          ? `timed out after ${timeoutMs}ms`
          : `network error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(
      rateLimited
        ? `Groq vision rate limited on every key (status 429): ${lastMessage}`
        : `Groq vision request failed after ${attempts} attempts: ${lastMessage}`,
    );
  }

  private toAnalysis(rawBody: string): VisualFrameAnalysis {
    let content: string | null | undefined;
    try {
      content = (JSON.parse(rawBody) as GroqChatCompletionResponse).choices?.[0]
        ?.message?.content;
    } catch {
      content = undefined;
    }
    if (!content) throw new Error('Groq vision returned empty content');
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(content.trim()) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('not an object');
      parsed = value as Record<string, unknown>;
    } catch {
      throw new Error('Groq vision returned invalid structured JSON');
    }
    const caption = this.text(parsed.caption, 4_000);
    if (!caption) throw new Error('Groq vision returned invalid caption');
    if (!Array.isArray(parsed.objects))
      throw new Error('Groq vision returned invalid objects');
    const objects = parsed.objects.filter(
      (item): item is string => typeof item === 'string',
    );
    if (objects.length !== parsed.objects.length)
      throw new Error('Groq vision returned invalid objects');
    const ocrText = this.text(parsed.ocrText, 4_000);
    return {
      caption,
      ...(ocrText ? { ocrText } : {}),
      objects: [
        ...new Set(
          objects
            .map((item) => item.replace(/\s+/g, ' ').trim())
            .filter(Boolean),
        ),
      ].slice(0, 30),
      provider: 'groq',
      model: this.model,
      version: this.version,
    };
  }

  private text(value: unknown, maxLength: number): string {
    return typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
      : '';
  }

  private errorMessage(raw: string): string {
    try {
      const message = (JSON.parse(raw) as GroqChatCompletionResponse).error
        ?.message;
      if (message) return message.slice(0, 300);
    } catch {
      // fall through to the raw body
    }
    return raw.trim().slice(0, 300) || 'Unknown Groq error';
  }

  private timeoutMs(): number {
    const value = Number(this.config.get<string>('GROQ_VISION_TIMEOUT_MS'));
    return Number.isInteger(value) && value >= 1_000 && value <= 40_000
      ? value
      : 35_000; // 3 attempts must fit inside the indexing RPC timeout of 120s
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('GROQ_BASE_URL')?.trim() ||
      'https://api.groq.com/openai/v1'
    ).replace(/\/+$/, '');
  }
}
