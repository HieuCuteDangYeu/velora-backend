import type { RagTelemetryEvent } from '@common/ai/dtos/rag-telemetry.dto';
import type { ReelPipelineTelemetryEvent } from '@common/processing/dtos/reel-pipeline-telemetry.dto';
import { PrometheusMetricsService } from './prometheus-metrics.service';

describe('PrometheusMetricsService RAG and Reel telemetry', () => {
  let metrics: PrometheusMetricsService;

  beforeEach(() => {
    metrics = new PrometheusMetricsService();
  });

  afterEach(() => {
    metrics.onModuleDestroy();
  });

  it('deduplicates RAG events and exports provider token usage plus Reel snapshot gauges', () => {
    const event: RagTelemetryEvent = {
      eventId: '11111111-1111-4111-8111-111111111111',
      outcome: 'SUCCEEDED',
      reelQuestionType: 'TRANSCRIPT_CONTENT',
      latencyMs: 1200,
      retrievedChunks: 3,
      contextSufficient: true,
      verifierPassed: true,
      fallbackUsed: false,
      retryCount: 1,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      finalFailureSource: 'NONE',
      tokenUsage: [
        {
          modelRole: 'answer',
          model: 'test-model',
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          reasoningTokens: 10,
        },
      ],
      occurredAt: '2026-09-22T10:00:00.000Z',
    };

    metrics.recordRagTelemetry(event);
    metrics.recordRagTelemetry(event);
    metrics.recordReelSnapshot({
      generatedAt: '2026-09-22T10:00:00.000Z',
      queued: 2,
      processing: 1,
      ready: 8,
      failed: 3,
      recentFailed: 1,
      degraded: 1,
      stalled: 1,
      readyLatencyP95Seconds: 42,
      media: {
        PENDING: 2,
        PROBING: 0,
        PROCESSING: 1,
        COMPLETED: 9,
        FAILED: 1,
      },
      index: {
        NOT_REQUESTED: 1,
        PENDING: 1,
        PROCESSING: 0,
        COMPLETED: 7,
        DEGRADED: 1,
        FAILED: 1,
      },
    });

    const output = metrics.metrics();

    expect(output).toContain(
      'velora_rag_requests_total{service="ai-service",outcome="SUCCEEDED",reel_question_type="TRANSCRIPT_CONTENT",final_failure_source="NONE",fallback="false"} 1',
    );
    expect(output).toContain(
      'velora_rag_input_tokens_total{service="ai-service",model_role="answer",model="test-model"} 100',
    );
    expect(output).toContain(
      'velora_rag_tokens_total{service="ai-service",model_role="answer",model="test-model"} 140',
    );
    expect(output).toContain(
      'velora_rag_request_tokens_count{service="ai-service"} 1',
    );
    expect(output).toContain(
      'velora_reel_pipeline_recent_failures{service="content-service"} 1',
    );
    expect(output).toContain(
      'velora_reel_pipeline_items{service="content-service",state="stalled"} 1',
    );
  });

  it('deduplicates Reel worker events and exports retries, durations, and index quality counters', () => {
    const mediaFailure: ReelPipelineTelemetryEvent = {
      eventId: '22222222-2222-4222-8222-222222222222',
      pipeline: 'MEDIA',
      lane: 'SHORT',
      stage: 'TOTAL_PIPELINE',
      outcome: 'FAILED',
      durationMs: 2500,
      retryNumber: 2,
      occurredAt: '2026-09-22T10:01:00.000Z',
    };
    const indexSuccess: ReelPipelineTelemetryEvent = {
      eventId: '33333333-3333-4333-8333-333333333333',
      pipeline: 'INDEX',
      lane: 'LONG',
      stage: 'TOTAL_PIPELINE',
      outcome: 'SUCCEEDED',
      durationMs: 7000,
      retryNumber: 1,
      itemCounts: { reelDocuments: 1, sections: 2, chunks: 0 },
      occurredAt: '2026-09-22T10:02:00.000Z',
    };

    metrics.recordReelPipelineTelemetry(mediaFailure);
    metrics.recordReelPipelineTelemetry(mediaFailure);
    metrics.recordReelPipelineTelemetry(indexSuccess);

    const output = metrics.metrics();

    expect(output).toContain(
      'velora_reel_worker_stage_runs_total{pipeline="MEDIA",lane="SHORT",stage="TOTAL_PIPELINE",outcome="FAILED",retry_number="2"} 1',
    );
    expect(output).toContain(
      'velora_reel_worker_stage_duration_seconds_count{pipeline="MEDIA",lane="SHORT",stage="TOTAL_PIPELINE",outcome="FAILED",retry_number="2"} 1',
    );
    expect(output).toContain(
      'velora_reel_worker_retries_total{pipeline="MEDIA",lane="SHORT",retry_number="2"} 1',
    );
    expect(output).toContain(
      'velora_reel_worker_exhausted_retries_total{pipeline="MEDIA",lane="SHORT"} 1',
    );
    expect(output).toContain(
      'velora_reel_index_items_total{kind="reel_document"} 1',
    );
    expect(output).toContain('velora_reel_index_items_total{kind="section"} 2');
    expect(output).toContain('velora_reel_index_items_total{kind="chunk"} 0');
    expect(output).toContain('velora_reel_index_zero_chunk_total{} 1');
  });
});
