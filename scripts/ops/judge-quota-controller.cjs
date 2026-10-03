'use strict';

const { appendFileSync, mkdirSync, readFileSync } = require('node:fs');
const { dirname } = require('node:path');

class JudgeQuotaController {
  constructor(options) {
    if (!Number.isInteger(options?.tpmLimit) || options.tpmLimit <= 0) {
      throw new Error('tpmLimit must be a positive integer');
    }
    this.options = {
      ...options,
      maxRetries: Math.max(0, options.maxRetries ?? 2),
      now: options.now ?? Date.now,
      sleep:
        options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
    this.records = this.readLedger();
    this.queue = Promise.resolve();
  }

  async run(requestId, estimatedTokens, operation) {
    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw new Error('requestId is required');
    }
    if (!Number.isInteger(estimatedTokens) || estimatedTokens <= 0) {
      throw new Error('estimatedTokens must be a positive integer');
    }

    return this.lock(async () => {
      const prior = this.records.find(
        (record) => record.requestId === requestId && record.type !== 'reserve',
      );
      if (prior?.type === 'complete') return prior.result;
      if (prior?.type === 'failed') throw this.errorFromRecord(prior);

      for (
        let attempt = 1;
        attempt <= this.options.maxRetries + 1;
        attempt += 1
      ) {
        await this.reserve(`${requestId}:${attempt}`, estimatedTokens);
        try {
          const result = await operation(attempt);
          this.append({
            type: 'complete',
            requestId,
            at: this.options.now(),
            result,
          });
          return result;
        } catch (error) {
          if (!this.isRetryable(error) || attempt > this.options.maxRetries) {
            const failure = this.safeError(error);
            this.append({
              type: 'failed',
              requestId,
              at: this.options.now(),
              error: failure,
            });
            throw Object.assign(new Error(failure.message), {
              code: failure.code,
            });
          }
          await this.options.sleep(this.retryAfterMs(error));
        }
      }
      throw new Error('judge retry loop exhausted');
    });
  }

  async reserve(requestId, tokens) {
    while (true) {
      const now = this.options.now();
      const minuteAgo = now - 60_000;
      const used = this.records
        .filter((record) => record.type === 'reserve' && record.at >= minuteAgo)
        .reduce((total, record) => total + (record.tokens ?? 0), 0);
      if (used + tokens <= this.options.tpmLimit) break;
      const first = this.records.find(
        (record) => record.type === 'reserve' && record.at >= minuteAgo,
      );
      const waitMs = Math.max(1, (first?.at ?? now) + 60_000 - now);
      await this.options.sleep(waitMs);
    }

    const now = this.options.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const dailyTokens = this.records
      .filter(
        (record) =>
          record.type === 'reserve' &&
          new Date(record.at).toISOString().slice(0, 10) === day,
      )
      .reduce((total, record) => total + (record.tokens ?? 0), 0);
    if (
      this.options.tpdLimit !== undefined &&
      dailyTokens + tokens > this.options.tpdLimit
    ) {
      throw Object.assign(new Error('judge daily token budget exhausted'), {
        code: 'JUDGE_TPD_EXHAUSTED',
      });
    }
    this.append({ type: 'reserve', requestId, at: now, tokens });
  }

  isRetryable(error) {
    const status = this.status(error);
    const message = this.safeError(error).message.toLowerCase();
    if (
      message.includes('daily') ||
      message.includes('tokens per day') ||
      message.includes('quota exhausted')
    ) {
      return false;
    }
    return (
      status === 408 ||
      status === 429 ||
      status >= 500 ||
      /timeout|network|connect/.test(message)
    );
  }

  retryAfterMs(error) {
    const headers = error?.headers ?? {};
    const retryAfter = Number(
      headers['retry-after'] ?? headers['x-ratelimit-reset-tokens'],
    );
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return retryAfter * (retryAfter < 100 ? 1_000 : 1);
    }
    const match = this.safeError(error).message.match(
      /try again in ([0-9.]+)\s*(ms|s|m)?/i,
    );
    if (!match) return 1_000;
    const multiplier =
      match[2]?.toLowerCase() === 'ms'
        ? 1
        : match[2]?.toLowerCase() === 'm'
          ? 60_000
          : 1_000;
    return Math.max(1, Number(match[1]) * multiplier);
  }

  status(error) {
    const status = error?.status;
    return typeof status === 'number' ? status : 0;
  }

  safeError(error) {
    return {
      code:
        typeof error?.code === 'string'
          ? error.code.slice(0, 120)
          : 'JUDGE_ERROR',
      message: (typeof error?.message === 'string'
        ? error.message
        : String(error)
      ).slice(0, 240),
    };
  }

  errorFromRecord(record) {
    return Object.assign(
      new Error(record.error?.message ?? 'judge request failed'),
      {
        code: record.error?.code ?? 'JUDGE_ERROR',
      },
    );
  }

  append(record) {
    mkdirSync(dirname(this.options.ledgerPath), { recursive: true });
    appendFileSync(
      this.options.ledgerPath,
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
    this.records.push(record);
  }

  readLedger() {
    try {
      return readFileSync(this.options.ledgerPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error(
        `judge quota ledger unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ponytail: one process-wide queue keeps the append-only ledger coherent; use a DB/lock service if judges become multi-process.
  async lock(operation) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

module.exports = {
  JudgeQuotaController,
};
