'use strict';

const { JudgeQuotaController } = require('./judge-quota-controller.cjs');

const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_CLOUDFLARE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_ESTIMATED_TOKENS = 1200;

function formatRetrievedContext(citations) {
  if (!citations) return 'No context retrieved.';
  if (typeof citations === 'string') return citations.trim() || 'No context retrieved.';
  if (!Array.isArray(citations) || citations.length === 0) return 'No context retrieved.';

  const formatted = citations
    .map((c, i) => {
      if (typeof c === 'string') return `[Source ${i + 1}] ${c}`;
      const parts = [];
      if (c.title) parts.push(`Title: ${c.title}`);
      if (c.evidenceType) parts.push(`Type: ${c.evidenceType}`);
      if (c.startTime != null && c.endTime != null) {
        parts.push(`Time: ${c.startTime}s - ${c.endTime}s`);
      }
      if (c.quote) parts.push(`Quote: "${c.quote}"`);
      return `[Source ${i + 1}] ${parts.length ? parts.join(' | ') : JSON.stringify(c)}`;
    })
    .filter(Boolean);

  return formatted.length ? formatted.join('\n\n') : 'No context retrieved.';
}

function buildJudgePrompt({ question, referenceAnswer, generatedAnswer, context }) {
  const q = String(question ?? '').trim();
  const ref = String(referenceAnswer ?? '').trim();
  const gen = String(generatedAnswer ?? '').trim();
  const ctx = typeof context === 'string' ? context.trim() : formatRetrievedContext(context);

  return `You are an expert impartial LLM judge evaluating a RAG (Retrieval-Augmented Generation) system.
Evaluate the generated answer against the question, reference answer, and retrieved context across these four dimensions:

1. Faithfulness (0.0 - 1.0): Is the generated answer completely faithful to the retrieved context? Are all factual assertions derived strictly from the retrieved context without hallucination or unsupported claims?
2. Factual Correctness (0.0 - 1.0): Does the generated answer factually agree with the ground-truth reference answer?
3. Response Relevancy (0.0 - 1.0): Does the generated answer directly address and answer the user question?
4. Context Completeness (0.0 - 1.0): Does the retrieved context contain the information needed to answer the question as represented in the reference answer?

Scoring guidelines:
- 1.0: Perfect alignment / complete coverage / completely faithful.
- 0.5 - 0.9: Partially correct, partially covered, or minor omissions.
- 0.1 - 0.4: Major discrepancies, weak alignment, or mostly unsupported.
- 0.0: Completely contradicted, entirely hallucinated, or wholly irrelevant.

Respond ONLY with a JSON object adhering to this schema:
{
  "faithfulness": { "score": number, "reasoning": "string" },
  "factualCorrectness": { "score": number, "reasoning": "string" },
  "responseRelevancy": { "score": number, "reasoning": "string" },
  "contextCompleteness": { "score": number, "reasoning": "string" }
}

[QUESTION]
${q}

[REFERENCE ANSWER]
${ref}

[RETRIEVED CONTEXT]
${ctx}

[GENERATED ANSWER]
${gen || '[NO ANSWER GENERATED]'}
`;
}

function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try extracting JSON from markdown code blocks
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        // Fall through
      }
    }
    // Try finding the first '{' and last '}'
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through
      }
    }
  }
  return null;
}

function clampScore(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0.0;
  return Math.max(0.0, Math.min(1.0, Math.round(num * 1000) / 1000));
}

function normalizeJudgeOutput(rawOutput) {
  const parsed = typeof rawOutput === 'string' ? extractJson(rawOutput) : rawOutput;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Failed to parse judge output as JSON: ${String(rawOutput).slice(0, 100)}`);
  }

  const getDimension = (...keys) => {
    for (const key of keys) {
      if (parsed[key] !== undefined) {
        const val = parsed[key];
        if (typeof val === 'object' && val !== null) {
          return {
            score: clampScore(val.score ?? val.value),
            reasoning: String(val.reasoning ?? val.comment ?? val.explanation ?? '').trim() || 'No reasoning provided.',
          };
        }
        if (typeof val === 'number') {
          return { score: clampScore(val), reasoning: 'Score provided without explanation.' };
        }
      }
    }
    return { score: 0.0, reasoning: 'Dimension missing in judge evaluation.' };
  };

  return {
    faithfulness: getDimension('faithfulness', 'faithful'),
    factualCorrectness: getDimension('factualCorrectness', 'factual_correctness', 'correctness', 'accuracy'),
    responseRelevancy: getDimension('responseRelevancy', 'response_relevancy', 'relevancy', 'relevance'),
    contextCompleteness: getDimension('contextCompleteness', 'context_completeness', 'context_recall', 'completeness', 'recall'),
  };
}

async function callGroqJudge({
  apiKey,
  prompt,
  model = DEFAULT_GROQ_MODEL,
  timeoutMs = 45000,
  fetchFn = globalThis.fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are an expert impartial evaluation judge. You always output valid JSON.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.0,
        max_completion_tokens: 1536,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const err = new Error(`Groq judge error ${res.status}: ${errorBody.slice(0, 300)}`);
      err.status = res.status;
      err.headers = Object.fromEntries(res.headers.entries());
      throw err;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Groq judge returned empty choice content');
    }

    return {
      rawContent: content,
      provider: 'groq',
      model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
        totalTokens: data.usage?.total_tokens ?? null,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callCloudflareJudge({
  accountId,
  apiToken,
  prompt,
  model = DEFAULT_CLOUDFLARE_MODEL,
  timeoutMs = 45000,
  fetchFn = globalThis.fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are an expert evaluation judge. You always output valid JSON adhering to the specified schema.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const err = new Error(`Cloudflare judge error ${res.status}: ${errorBody.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const content = data?.result?.response ?? (typeof data?.result === 'string' ? data.result : null);
    if (!content) {
      throw new Error(`Cloudflare judge returned unexpected payload: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return {
      rawContent: content,
      provider: 'cloudflare',
      model,
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

class JudgePoolController {
  constructor(options) {
    const groqKeys = (options.groqApiKeys || [])
      .map((k) => k?.trim())
      .filter(Boolean);

    this.groqKeys = groqKeys;
    this.cloudflareAccountId = options.cloudflareAccountId;
    this.cloudflareApiToken = options.cloudflareApiToken;
    this.ledgerBaseDir = options.ledgerBaseDir || '.benchmarks/judge-ledgers';
    this.tpmLimitPerKey = options.tpmLimitPerKey || 6500;
    this.tpdLimitPerKey = options.tpdLimitPerKey;
    this.nextKeyIndex = 0;

    this.groqControllers = groqKeys.map((key, i) => {
      return {
        key,
        index: i,
        controller: new JudgeQuotaController({
          tpmLimit: this.tpmLimitPerKey,
          tpdLimit: this.tpdLimitPerKey,
          ledgerPath: `${this.ledgerBaseDir}/groq-key-${i}.jsonl`,
          maxRetries: options.maxRetries ?? 2,
        }),
      };
    });
  }

  async evaluateCase({
    caseId,
    question,
    referenceAnswer,
    generatedAnswer,
    context,
    estimatedTokens = DEFAULT_ESTIMATED_TOKENS,
    fetchFn = globalThis.fetch,
  }) {
    const prompt = buildJudgePrompt({
      question,
      referenceAnswer,
      generatedAnswer,
      context,
    });

    let lastError = null;

    // Try Groq pool first
    if (this.groqControllers.length > 0) {
      const startIndex = this.nextKeyIndex;
      for (let attempt = 0; attempt < this.groqControllers.length; attempt += 1) {
        const slot = this.groqControllers[(startIndex + attempt) % this.groqControllers.length];
        this.nextKeyIndex = (startIndex + attempt + 1) % this.groqControllers.length;

        try {
          const rawResult = await slot.controller.run(caseId, estimatedTokens, async () => {
            return callGroqJudge({
              apiKey: slot.key,
              prompt,
              fetchFn,
            });
          });

          const normalized = normalizeJudgeOutput(rawResult.rawContent);
          return {
            caseId,
            ...normalized,
            provider: rawResult.provider,
            model: rawResult.model,
            usage: rawResult.usage,
          };
        } catch (error) {
          lastError = error;
          // If TPD exhausted on this key or non-retryable error, try next key in pool
          continue;
        }
      }
    }

    // Fallback to Cloudflare Workers AI if configured
    if (this.cloudflareAccountId && this.cloudflareApiToken) {
      try {
        const rawResult = await callCloudflareJudge({
          accountId: this.cloudflareAccountId,
          apiToken: this.cloudflareApiToken,
          prompt,
          fetchFn,
        });

        const normalized = normalizeJudgeOutput(rawResult.rawContent);
        return {
          caseId,
          ...normalized,
          provider: rawResult.provider,
          model: rawResult.model,
          usage: rawResult.usage,
        };
      } catch (cfError) {
        throw new Error(
          `All judge providers exhausted for ${caseId}. Groq error: ${lastError?.message}; Cloudflare error: ${cfError.message}`,
        );
      }
    }

    throw lastError || new Error(`No judge provider available for ${caseId}`);
  }
}

module.exports = {
  DEFAULT_CLOUDFLARE_MODEL,
  DEFAULT_ESTIMATED_TOKENS,
  DEFAULT_GROQ_MODEL,
  JudgePoolController,
  buildJudgePrompt,
  callCloudflareJudge,
  callGroqJudge,
  clampScore,
  extractJson,
  formatRetrievedContext,
  normalizeJudgeOutput,
};
