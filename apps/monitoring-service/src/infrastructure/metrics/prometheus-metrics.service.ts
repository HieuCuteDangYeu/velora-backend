import type { RagTelemetryEvent } from '@common/ai/dtos/rag-telemetry.dto';
import type { ReelMonitoringSnapshot } from '@common/content/dtos/reel-monitoring-snapshot.dto';
import type { ReelPipelineTelemetryEvent } from '@common/processing/dtos/reel-pipeline-telemetry.dto';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

type RpcStatus = 'success' | 'error';

type HistogramState = {
  bucketCounts: number[];
  count: number;
  sum: number;
};

@Injectable()
export class PrometheusMetricsService implements OnModuleDestroy {
  static readonly CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly serviceName = 'monitoring-service';
  private readonly durationBuckets = [
    0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5,
  ];
  private readonly rpcRequestCounts = new Map<string, number>();
  private readonly rpcDurations = new Map<string, HistogramState>();
  private readonly telemetryEventCounts = new Map<string, number>();
  private readonly ragDurationBuckets = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30];
  private readonly ragTokenBuckets = [
    256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
  ];
  private readonly ragRequestCounts = new Map<string, number>();
  private readonly ragRequestDurations = new Map<string, HistogramState>();
  private readonly ragRequestTokens: HistogramState = {
    bucketCounts: this.ragTokenBuckets.map(() => 0),
    count: 0,
    sum: 0,
  };
  private readonly ragTokenCounts = new Map<
    string,
    { input: number; output: number; total: number; reasoning: number }
  >();
  private readonly ragRetryCounts = new Map<string, number>();
  private readonly seenRagEventIds = new Set<string>();
  private readonly seenRagEventOrder: string[] = [];
  private ragRetrievedChunks = 0;
  private ragContextInsufficient = 0;
  private ragVerifierFailures = 0;
  private ragFallbacks = 0;
  private readonly reelStageDurationBuckets = [
    0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200,
  ];
  private readonly reelStageCounts = new Map<string, number>();
  private readonly reelStageDurations = new Map<string, HistogramState>();
  private readonly reelRetryCounts = new Map<string, number>();
  private readonly reelExhaustedRetryCounts = new Map<string, number>();
  private readonly reelIndexItemCounts = new Map<string, number>();
  private readonly seenReelTelemetryEventIds = new Set<string>();
  private readonly seenReelTelemetryEventOrder: string[] = [];
  private reelIndexZeroChunkCount = 0;
  private reelSnapshot: ReelMonitoringSnapshot | null = null;
  private reelSnapshotUp = 0;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.eventLoopDelay.enable();
  }

  onModuleDestroy() {
    this.eventLoopDelay.disable();
  }

  recordRpc(pattern: string, status: RpcStatus, durationSeconds: number) {
    const key = this.rpcKey(pattern, status);
    this.rpcRequestCounts.set(key, (this.rpcRequestCounts.get(key) ?? 0) + 1);

    const state = this.rpcDurations.get(key) ?? {
      bucketCounts: this.durationBuckets.map(() => 0),
      count: 0,
      sum: 0,
    };

    state.count += 1;
    state.sum += durationSeconds;
    this.durationBuckets.forEach((bucket, index) => {
      if (durationSeconds <= bucket) {
        state.bucketCounts[index] += 1;
      }
    });
    this.rpcDurations.set(key, state);
  }

  addTelemetryEvents(
    type: 'call' | 'recommendation' | 'rag' | 'reel',
    count: number,
  ) {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }

    this.telemetryEventCounts.set(
      type,
      (this.telemetryEventCounts.get(type) ?? 0) + count,
    );
  }

  recordRagTelemetry(event: RagTelemetryEvent): void {
    if (this.seenRagEventIds.has(event.eventId)) return;
    this.seenRagEventIds.add(event.eventId);
    this.seenRagEventOrder.push(event.eventId);
    if (this.seenRagEventOrder.length > 10_000) {
      const expired = this.seenRagEventOrder.shift();
      if (expired) this.seenRagEventIds.delete(expired);
    }

    const requestKey = JSON.stringify([
      event.outcome,
      event.reelQuestionType,
      event.finalFailureSource,
      event.fallbackUsed ? 'true' : 'false',
    ]);
    this.ragRequestCounts.set(
      requestKey,
      (this.ragRequestCounts.get(requestKey) ?? 0) + 1,
    );

    const durationKey = event.outcome;
    const durationState =
      this.ragRequestDurations.get(durationKey) ??
      this.emptyHistogram(this.ragDurationBuckets);
    this.observeHistogram(
      durationState,
      this.ragDurationBuckets,
      event.latencyMs / 1000,
    );
    this.ragRequestDurations.set(durationKey, durationState);

    this.ragRetrievedChunks += event.retrievedChunks;
    if (event.contextSufficient === false) this.ragContextInsufficient += 1;
    if (event.verifierPassed === false) this.ragVerifierFailures += 1;
    if (event.fallbackUsed) this.ragFallbacks += 1;
    this.addRagRetry('answer', event.retryCount);
    this.addRagRetry('retrieval', event.retrievalRetryCount);
    this.addRagRetry('citation', event.citationRetryCount);

    let requestTokens = 0;
    for (const usage of event.tokenUsage) {
      const key = JSON.stringify([usage.modelRole, usage.model]);
      const current = this.ragTokenCounts.get(key) ?? {
        input: 0,
        output: 0,
        total: 0,
        reasoning: 0,
      };
      current.input += usage.inputTokens;
      current.output += usage.outputTokens;
      current.total += usage.totalTokens;
      current.reasoning += usage.reasoningTokens ?? 0;
      requestTokens += usage.totalTokens;
      this.ragTokenCounts.set(key, current);
    }
    this.observeHistogram(
      this.ragRequestTokens,
      this.ragTokenBuckets,
      requestTokens,
    );
    this.addTelemetryEvents('rag', 1);
  }

  recordReelSnapshot(snapshot: ReelMonitoringSnapshot): void {
    this.reelSnapshot = snapshot;
    this.reelSnapshotUp = 1;
  }

  markReelSnapshotUnavailable(): void {
    this.reelSnapshotUp = 0;
  }

  recordReelPipelineTelemetry(event: ReelPipelineTelemetryEvent): void {
    if (this.seenReelTelemetryEventIds.has(event.eventId)) return;
    this.seenReelTelemetryEventIds.add(event.eventId);
    this.seenReelTelemetryEventOrder.push(event.eventId);
    if (this.seenReelTelemetryEventOrder.length > 10_000) {
      const expired = this.seenReelTelemetryEventOrder.shift();
      if (expired) this.seenReelTelemetryEventIds.delete(expired);
    }

    const stageKey = JSON.stringify([
      event.pipeline,
      event.lane,
      event.stage,
      event.outcome,
      String(event.retryNumber),
    ]);
    this.reelStageCounts.set(
      stageKey,
      (this.reelStageCounts.get(stageKey) ?? 0) + 1,
    );

    const durationState =
      this.reelStageDurations.get(stageKey) ??
      this.emptyHistogram(this.reelStageDurationBuckets);
    this.observeHistogram(
      durationState,
      this.reelStageDurationBuckets,
      event.durationMs / 1000,
    );
    this.reelStageDurations.set(stageKey, durationState);

    if (event.stage === 'TOTAL_PIPELINE') {
      if (event.retryNumber > 0) {
        const retryKey = JSON.stringify([
          event.pipeline,
          event.lane,
          String(event.retryNumber),
        ]);
        this.reelRetryCounts.set(
          retryKey,
          (this.reelRetryCounts.get(retryKey) ?? 0) + 1,
        );
      }

      if (event.outcome === 'FAILED' && event.retryNumber >= 2) {
        const exhaustedKey = JSON.stringify([event.pipeline, event.lane]);
        this.reelExhaustedRetryCounts.set(
          exhaustedKey,
          (this.reelExhaustedRetryCounts.get(exhaustedKey) ?? 0) + 1,
        );
      }

      if (event.pipeline === 'INDEX' && event.itemCounts) {
        for (const [kind, count] of Object.entries({
          reel_document: event.itemCounts.reelDocuments,
          section: event.itemCounts.sections,
          chunk: event.itemCounts.chunks,
        })) {
          this.reelIndexItemCounts.set(
            kind,
            (this.reelIndexItemCounts.get(kind) ?? 0) + count,
          );
        }
        if (event.itemCounts.chunks === 0) this.reelIndexZeroChunkCount += 1;
      }
    }

    this.addTelemetryEvents('reel', 1);
  }

  metrics(): string {
    const lines: string[] = [];
    const serviceLabels = this.labels({ service: this.serviceName });
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const eventLoopMeanSeconds = this.nanosecondsToSeconds(
      this.eventLoopDelay.mean,
    );
    const eventLoopP99Seconds = this.nanosecondsToSeconds(
      this.eventLoopDelay.percentile(99),
    );

    this.metricHeader(
      lines,
      'velora_process_cpu_user_seconds_total',
      'Total user CPU time consumed by the monitoring service in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_user_seconds_total${serviceLabels} ${cpu.user / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_cpu_system_seconds_total',
      'Total system CPU time consumed by the monitoring service in seconds.',
      'counter',
    );
    lines.push(
      `velora_process_cpu_system_seconds_total${serviceLabels} ${cpu.system / 1_000_000}`,
    );

    this.metricHeader(
      lines,
      'velora_process_resident_memory_bytes',
      'Resident set size of the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(
      `velora_process_resident_memory_bytes${serviceLabels} ${memory.rss}`,
    );

    this.metricHeader(
      lines,
      'velora_process_heap_bytes',
      'Total V8 heap size of the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(`velora_process_heap_bytes${serviceLabels} ${memory.heapTotal}`);

    this.metricHeader(
      lines,
      'velora_process_heap_used_bytes',
      'Used V8 heap size of the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(
      `velora_process_heap_used_bytes${serviceLabels} ${memory.heapUsed}`,
    );

    this.metricHeader(
      lines,
      'velora_process_external_memory_bytes',
      'External memory used by the monitoring service process in bytes.',
      'gauge',
    );
    lines.push(
      `velora_process_external_memory_bytes${serviceLabels} ${memory.external}`,
    );

    this.metricHeader(
      lines,
      'velora_process_uptime_seconds',
      'Monitoring service process uptime in seconds.',
      'gauge',
    );
    lines.push(
      `velora_process_uptime_seconds${serviceLabels} ${process.uptime()}`,
    );

    this.metricHeader(
      lines,
      'velora_process_start_time_seconds',
      'Unix timestamp when the monitoring service process started.',
      'gauge',
    );
    lines.push(
      `velora_process_start_time_seconds${serviceLabels} ${Date.now() / 1000 - process.uptime()}`,
    );

    this.metricHeader(
      lines,
      'velora_nodejs_event_loop_lag_seconds',
      'Mean Node.js event-loop delay observed since the previous metrics scrape in seconds.',
      'gauge',
    );
    lines.push(
      `velora_nodejs_event_loop_lag_seconds${serviceLabels} ${eventLoopMeanSeconds}`,
    );

    this.metricHeader(
      lines,
      'velora_nodejs_event_loop_lag_p99_seconds',
      'p99 Node.js event-loop delay observed since the previous metrics scrape in seconds.',
      'gauge',
    );
    lines.push(
      `velora_nodejs_event_loop_lag_p99_seconds${serviceLabels} ${eventLoopP99Seconds}`,
    );

    this.metricHeader(
      lines,
      'velora_monitoring_rpc_requests_total',
      'Total RabbitMQ RPC/event operations handled by monitoring-service.',
      'counter',
    );
    for (const [key, count] of this.rpcRequestCounts.entries()) {
      const [pattern, status] = this.parseRpcKey(key);
      lines.push(
        `velora_monitoring_rpc_requests_total${this.labels({ service: this.serviceName, pattern, status })} ${count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_monitoring_rpc_duration_seconds',
      'Duration of RabbitMQ RPC/event operations handled by monitoring-service.',
      'histogram',
    );
    for (const [key, state] of this.rpcDurations.entries()) {
      const [pattern, status] = this.parseRpcKey(key);
      const baseLabels = {
        service: this.serviceName,
        pattern,
        status,
      };

      this.durationBuckets.forEach((bucket, index) => {
        lines.push(
          `velora_monitoring_rpc_duration_seconds_bucket${this.labels({ ...baseLabels, le: String(bucket) })} ${state.bucketCounts[index]}`,
        );
      });
      lines.push(
        `velora_monitoring_rpc_duration_seconds_bucket${this.labels({ ...baseLabels, le: '+Inf' })} ${state.count}`,
      );
      lines.push(
        `velora_monitoring_rpc_duration_seconds_sum${this.labels(baseLabels)} ${state.sum}`,
      );
      lines.push(
        `velora_monitoring_rpc_duration_seconds_count${this.labels(baseLabels)} ${state.count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_monitoring_telemetry_events_total',
      'Total application telemetry events accepted for processing by monitoring-service.',
      'counter',
    );
    for (const [type, count] of this.telemetryEventCounts.entries()) {
      lines.push(
        `velora_monitoring_telemetry_events_total${this.labels({ service: this.serviceName, type })} ${count}`,
      );
    }

    this.appendRagMetrics(lines);
    this.appendReelMetrics(lines);
    this.appendReelWorkerMetrics(lines);

    // Event-loop delay should describe the current scrape window instead of the
    // full process lifetime; otherwise one old spike keeps p99 elevated forever.
    this.eventLoopDelay.reset();

    return `${lines.join('\n')}\n`;
  }

  private rpcKey(pattern: string, status: RpcStatus) {
    return JSON.stringify([pattern, status]);
  }

  private parseRpcKey(key: string): [string, RpcStatus] {
    return JSON.parse(key) as [string, RpcStatus];
  }

  private appendRagMetrics(lines: string[]): void {
    this.metricHeader(
      lines,
      'velora_rag_requests_total',
      'Total RAG workflow requests observed by monitoring-service.',
      'counter',
    );
    for (const [key, count] of this.ragRequestCounts.entries()) {
      const [outcome, reelQuestionType, finalFailureSource, fallback] =
        JSON.parse(key) as string[];
      lines.push(
        `velora_rag_requests_total${this.labels({ service: 'ai-service', outcome, reel_question_type: reelQuestionType, final_failure_source: finalFailureSource, fallback })} ${count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_rag_request_duration_seconds',
      'RAG workflow end-to-end duration in seconds.',
      'histogram',
    );
    for (const [outcome, state] of this.ragRequestDurations.entries()) {
      this.appendHistogram(
        lines,
        'velora_rag_request_duration_seconds',
        state,
        this.ragDurationBuckets,
        { service: 'ai-service', outcome },
      );
    }

    this.counter(
      lines,
      'velora_rag_retrieved_chunks_total',
      'Total chunks retrieved by RAG workflows.',
      this.ragRetrievedChunks,
      { service: 'ai-service' },
    );
    this.counter(
      lines,
      'velora_rag_context_insufficient_total',
      'RAG requests whose context sufficiency gate rejected the available evidence.',
      this.ragContextInsufficient,
      { service: 'ai-service' },
    );
    this.counter(
      lines,
      'velora_rag_verifier_failures_total',
      'RAG requests whose verifier did not pass the answer.',
      this.ragVerifierFailures,
      { service: 'ai-service' },
    );
    this.counter(
      lines,
      'velora_rag_fallbacks_total',
      'RAG requests that used an answer or routing fallback.',
      this.ragFallbacks,
      { service: 'ai-service' },
    );

    this.metricHeader(
      lines,
      'velora_rag_retries_total',
      'Total RAG retries and revisions by kind.',
      'counter',
    );
    for (const [kind, count] of this.ragRetryCounts.entries()) {
      lines.push(
        `velora_rag_retries_total${this.labels({ service: 'ai-service', kind })} ${count}`,
      );
    }

    for (const [metric, field, help] of [
      [
        'velora_rag_input_tokens_total',
        'input',
        'Total RAG structured-LLM input tokens.',
      ],
      [
        'velora_rag_output_tokens_total',
        'output',
        'Total RAG structured-LLM output tokens.',
      ],
      ['velora_rag_tokens_total', 'total', 'Total RAG structured-LLM tokens.'],
      [
        'velora_rag_reasoning_tokens_total',
        'reasoning',
        'Total RAG structured-LLM reasoning tokens when reported by the provider.',
      ],
    ] as const) {
      this.metricHeader(lines, metric, help, 'counter');
      for (const [key, value] of this.ragTokenCounts.entries()) {
        const [modelRole, model] = JSON.parse(key) as string[];
        lines.push(
          `${metric}${this.labels({ service: 'ai-service', model_role: modelRole, model })} ${value[field]}`,
        );
      }
    }

    this.metricHeader(
      lines,
      'velora_rag_request_tokens',
      'Total structured-LLM tokens consumed by one RAG request.',
      'histogram',
    );
    this.appendHistogram(
      lines,
      'velora_rag_request_tokens',
      this.ragRequestTokens,
      this.ragTokenBuckets,
      { service: 'ai-service' },
    );
  }

  private appendReelMetrics(lines: string[]): void {
    this.gauge(
      lines,
      'velora_reel_pipeline_snapshot_up',
      'Whether the latest Reel monitoring snapshot was fetched successfully.',
      this.reelSnapshotUp,
      { service: 'content-service' },
    );
    const snapshot = this.reelSnapshot;
    if (!snapshot) return;

    this.gauge(
      lines,
      'velora_reel_pipeline_snapshot_timestamp_seconds',
      'Unix timestamp of the latest successful Reel monitoring snapshot.',
      Date.parse(snapshot.generatedAt) / 1000,
      { service: 'content-service' },
    );
    this.metricHeader(
      lines,
      'velora_reel_pipeline_items',
      'Current Reel pipeline records by operational state.',
      'gauge',
    );
    for (const [state, value] of Object.entries({
      queued: snapshot.queued,
      processing: snapshot.processing,
      ready: snapshot.ready,
      failed: snapshot.failed,
      degraded: snapshot.degraded,
      stalled: snapshot.stalled,
    })) {
      lines.push(
        `velora_reel_pipeline_items${this.labels({ service: 'content-service', state })} ${value}`,
      );
    }

    this.gauge(
      lines,
      'velora_reel_pipeline_recent_failures',
      'Reel pipeline failures recorded during the last 15 minutes.',
      snapshot.recentFailed,
      { service: 'content-service' },
    );

    this.metricHeader(
      lines,
      'velora_reel_media_status',
      'Current Reel records by media processing status.',
      'gauge',
    );
    for (const [status, value] of Object.entries(snapshot.media)) {
      lines.push(
        `velora_reel_media_status${this.labels({ service: 'content-service', status })} ${value}`,
      );
    }
    this.metricHeader(
      lines,
      'velora_reel_index_status',
      'Current Reel records by indexing status.',
      'gauge',
    );
    for (const [status, value] of Object.entries(snapshot.index)) {
      lines.push(
        `velora_reel_index_status${this.labels({ service: 'content-service', status })} ${value}`,
      );
    }
    if (snapshot.readyLatencyP95Seconds !== null) {
      this.gauge(
        lines,
        'velora_reel_pipeline_ready_latency_p95_seconds',
        'p95 create-to-ready latency for Reels reaching READY during the last 24 hours.',
        snapshot.readyLatencyP95Seconds,
        { service: 'content-service' },
      );
    }
  }

  private appendReelWorkerMetrics(lines: string[]): void {
    this.metricHeader(
      lines,
      'velora_reel_worker_stage_runs_total',
      'Reel media/index worker stage executions by pipeline stage and outcome.',
      'counter',
    );
    for (const [key, count] of this.reelStageCounts.entries()) {
      const [pipeline, lane, stage, outcome, retryNumber] = JSON.parse(
        key,
      ) as string[];
      lines.push(
        `velora_reel_worker_stage_runs_total${this.labels({ pipeline, lane, stage, outcome, retry_number: retryNumber })} ${count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_reel_worker_stage_duration_seconds',
      'Duration of Reel media/index worker stages in seconds.',
      'histogram',
    );
    for (const [key, state] of this.reelStageDurations.entries()) {
      const [pipeline, lane, stage, outcome, retryNumber] = JSON.parse(
        key,
      ) as string[];
      this.appendHistogram(
        lines,
        'velora_reel_worker_stage_duration_seconds',
        state,
        this.reelStageDurationBuckets,
        { pipeline, lane, stage, outcome, retry_number: retryNumber },
      );
    }

    this.metricHeader(
      lines,
      'velora_reel_worker_retries_total',
      'Reel worker attempts running as scheduled retries.',
      'counter',
    );
    for (const [key, count] of this.reelRetryCounts.entries()) {
      const [pipeline, lane, retryNumber] = JSON.parse(key) as string[];
      lines.push(
        `velora_reel_worker_retries_total${this.labels({ pipeline, lane, retry_number: retryNumber })} ${count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_reel_worker_exhausted_retries_total',
      'Reel worker attempts that failed after the final configured retry.',
      'counter',
    );
    for (const [key, count] of this.reelExhaustedRetryCounts.entries()) {
      const [pipeline, lane] = JSON.parse(key) as string[];
      lines.push(
        `velora_reel_worker_exhausted_retries_total${this.labels({ pipeline, lane })} ${count}`,
      );
    }

    this.metricHeader(
      lines,
      'velora_reel_index_items_total',
      'Semantic index items produced by completed Reel indexing attempts.',
      'counter',
    );
    for (const [kind, count] of this.reelIndexItemCounts.entries()) {
      lines.push(
        `velora_reel_index_items_total${this.labels({ kind })} ${count}`,
      );
    }
    this.counter(
      lines,
      'velora_reel_index_zero_chunk_total',
      'Completed Reel indexing attempts that produced zero semantic chunks.',
      this.reelIndexZeroChunkCount,
      {},
    );
  }

  private addRagRetry(kind: string, count: number): void {
    if (count <= 0) return;
    this.ragRetryCounts.set(kind, (this.ragRetryCounts.get(kind) ?? 0) + count);
  }

  private emptyHistogram(buckets: readonly number[]): HistogramState {
    return { bucketCounts: buckets.map(() => 0), count: 0, sum: 0 };
  }

  private observeHistogram(
    state: HistogramState,
    buckets: readonly number[],
    value: number,
  ): void {
    state.count += 1;
    state.sum += value;
    buckets.forEach((bucket, index) => {
      if (value <= bucket) state.bucketCounts[index] += 1;
    });
  }

  private appendHistogram(
    lines: string[],
    name: string,
    state: HistogramState,
    buckets: readonly number[],
    labels: Record<string, string>,
  ): void {
    buckets.forEach((bucket, index) => {
      lines.push(
        `${name}_bucket${this.labels({ ...labels, le: String(bucket) })} ${state.bucketCounts[index]}`,
      );
    });
    lines.push(
      `${name}_bucket${this.labels({ ...labels, le: '+Inf' })} ${state.count}`,
    );
    lines.push(`${name}_sum${this.labels(labels)} ${state.sum}`);
    lines.push(`${name}_count${this.labels(labels)} ${state.count}`);
  }

  private counter(
    lines: string[],
    name: string,
    help: string,
    value: number,
    labels: Record<string, string>,
  ): void {
    this.metricHeader(lines, name, help, 'counter');
    lines.push(`${name}${this.labels(labels)} ${value}`);
  }

  private gauge(
    lines: string[],
    name: string,
    help: string,
    value: number,
    labels: Record<string, string>,
  ): void {
    this.metricHeader(lines, name, help, 'gauge');
    lines.push(`${name}${this.labels(labels)} ${value}`);
  }

  private metricHeader(
    lines: string[],
    name: string,
    help: string,
    type: 'counter' | 'gauge' | 'histogram',
  ) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  }

  private labels(values: Record<string, string>) {
    const body = Object.entries(values)
      .map(([name, value]) => `${name}="${this.escapeLabel(value)}"`)
      .join(',');
    return `{${body}}`;
  }

  private escapeLabel(value: string) {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/"/g, '\\"');
  }

  private nanosecondsToSeconds(value: number) {
    return Number.isFinite(value) ? value / 1_000_000_000 : 0;
  }
}
