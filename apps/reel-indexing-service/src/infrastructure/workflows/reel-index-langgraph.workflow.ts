import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { ReelIndexDocument } from '@common/processing/interfaces/reel-index-document.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { VisualSceneEvidence } from '@common/processing/interfaces/visual-scene-evidence.interface';
import { AnalyzeVisualFrameManifestUseCase } from '@indexing/application/use-cases/analyze-visual-frame-manifest.use-case';
import { BuildAdaptiveTranscriptSectionsUseCase } from '@indexing/application/use-cases/build-adaptive-transcript-sections.use-case';
import { BuildHierarchicalIndexUseCase } from '@indexing/application/use-cases/build-hierarchical-index.use-case';
import { BuildTranscriptSectionsUseCase } from '@indexing/application/use-cases/build-transcript-sections.use-case';
import { CommitSemanticCandidateUseCase } from '@indexing/application/use-cases/commit-semantic-candidate.use-case';
import { ExtractHierarchicalMetadataUseCase } from '@indexing/application/use-cases/extract-hierarchical-metadata.use-case';
import { MergeTranscriptSegmentsUseCase } from '@indexing/application/use-cases/merge-transcript-segments.use-case';
import { SelectHealthyTranscriptSectionsUseCase } from '@indexing/application/use-cases/select-healthy-transcript-sections.use-case';
import { TranscribeAudioManifestUseCase } from '@indexing/application/use-cases/transcribe-audio-manifest.use-case';
import { ValidateEmbeddingQualityUseCase } from '@indexing/application/use-cases/validate-embedding-quality.use-case';
import { ValidateEvidenceIndexCandidateUseCase } from '@indexing/application/use-cases/validate-evidence-index-candidate.use-case';
import { ValidatePersistedSemanticCandidateUseCase } from '@indexing/application/use-cases/validate-persisted-semantic-candidate.use-case';
import type {
  IndexCheckpointStage,
  TranscriptSection,
} from '@indexing/domain/entities/index-checkpoint.entity';
import { IndexClassificationMismatchError } from '@indexing/domain/errors/index-classification-mismatch.error';
import type { IArtifactStorage } from '@indexing/domain/interfaces/artifact-storage.interface';
import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import type { IIndexCheckpointRepository } from '@indexing/domain/interfaces/index-checkpoint.repository.interface';
import type {
  IReelIndexWorkflow,
  ReelIndexWorkflowStatus,
} from '@indexing/domain/interfaces/reel-index-workflow.interface';
import type { ISemanticIndexRepository } from '@indexing/domain/interfaces/semantic-index.repository.interface';
import { PrismaLangGraphCheckpointSaver } from '@indexing/infrastructure/repositories/prisma-langgraph-checkpoint-saver';
import { IndexingMetricsService } from '@indexing/infrastructure/services/indexing-metrics.service';
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod/v4';

export type ReelIndexRoute = 'NO_AUDIO' | 'SHORT' | 'LONG';

export function routeIndexing(input: {
  hasAudio: boolean;
  durationMs: number;
  sourceLengthClass: 'SHORT' | 'LONG';
  shortMaximumSeconds: number;
}): ReelIndexRoute {
  if (!input.hasAudio) return 'NO_AUDIO';
  const calculated =
    input.durationMs <= input.shortMaximumSeconds * 1000 ? 'SHORT' : 'LONG';
  if (input.sourceLengthClass !== calculated) {
    throw new IndexClassificationMismatchError({
      provided: input.sourceLengthClass,
      calculated,
      durationMs: input.durationMs,
    });
  }
  return calculated;
}

export interface ReelIndexGraphState {
  job: ReelIndexJob;
  allowReclaim: boolean;
  retryNumber: number;
  route?: ReelIndexRoute;
  currentStage?: string;
  progress: number;
  status?: ReelIndexWorkflowStatus;
  metadataQuality?: 'strong' | 'weak';
  chunkingStrategy?: 'metadata-only' | 'short' | 'long';
  candidateSections?: TranscriptSection[];
  visualScenes: VisualSceneEvidence[];
  visualReady: boolean;
  transcriptReady: boolean;
  indexCompletion?: CompleteReelIndexCommand;
  warnings: string[];
  failure?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

const ReelIndexGraphStateSchema = new StateSchema({
  job: z.any(),
  allowReclaim: z.boolean().default(false),
  retryNumber: z.number().int().nonnegative().default(0),
  route: z.enum(['NO_AUDIO', 'SHORT', 'LONG']).optional(),
  currentStage: z.string().optional(),
  progress: z.number().default(0),
  status: z.enum(['COMPLETED', 'DUPLICATE', 'STALE']).optional(),
  metadataQuality: z.enum(['strong', 'weak']).optional(),
  chunkingStrategy: z.enum(['metadata-only', 'short', 'long']).optional(),
  candidateSections: z.array(z.any()).optional(),
  visualScenes: z.array(z.any()).default([]),
  visualReady: z.boolean().default(false),
  transcriptReady: z.boolean().default(false),
  indexCompletion: z.any().optional(),
  warnings: z.array(z.string()).default([]),
  failure: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
});

@Injectable()
export class ReelIndexLangGraphWorkflow implements IReelIndexWorkflow {
  private readonly invokeGraph: (
    state: ReelIndexGraphState,
    config: { configurable: { thread_id: string } },
  ) => Promise<ReelIndexGraphState>;

  constructor(
    private readonly config: ConfigService,
    private readonly transcribeAudio: TranscribeAudioManifestUseCase,
    private readonly analyzeVisualFrames: AnalyzeVisualFrameManifestUseCase,
    private readonly mergeTranscript: MergeTranscriptSegmentsUseCase,
    private readonly buildSections: BuildTranscriptSectionsUseCase,
    private readonly buildAdaptiveSections: BuildAdaptiveTranscriptSectionsUseCase,
    private readonly selectHealthySections: SelectHealthyTranscriptSectionsUseCase,
    private readonly extractMetadata: ExtractHierarchicalMetadataUseCase,
    private readonly buildIndex: BuildHierarchicalIndexUseCase,
    private readonly validateEmbeddingQuality: ValidateEmbeddingQualityUseCase,
    private readonly validateCandidate: ValidateEvidenceIndexCandidateUseCase,
    private readonly validatePersistedCandidate: ValidatePersistedSemanticCandidateUseCase,
    private readonly commitCandidate: CommitSemanticCandidateUseCase,
    private readonly checkpointer: PrismaLangGraphCheckpointSaver,
    @Inject('IArtifactStorage') private readonly storage: IArtifactStorage,
    @Inject('IIndexCheckpointRepository')
    private readonly checkpoints: IIndexCheckpointRepository,
    @Inject('IIndexingContentService')
    private readonly content: IIndexingContentService,
    @Inject('ISemanticIndexRepository')
    private readonly semanticIndex: ISemanticIndexRepository,
    private readonly indexingMetrics: IndexingMetricsService,
  ) {
    const graph = this.buildGraph().compile({
      checkpointer: this.checkpointer,
    });
    this.invokeGraph = async (state, config) =>
      await graph.invoke(state, config);
  }

  async execute(input: {
    job: ReelIndexJob;
    allowReclaim: boolean;
    retryNumber?: number;
    queuedAt?: string;
  }): Promise<ReelIndexWorkflowStatus> {
    const retryNumber = input.retryNumber ?? 0;
    const queuedAtMs = Date.parse(input.queuedAt ?? input.job.createdAt);
    this.indexingMetrics.record({
      job: input.job,
      retryNumber,
      stage: 'QUEUE_WAIT',
      success: Number.isFinite(queuedAtMs),
      durationMs: Number.isFinite(queuedAtMs)
        ? Math.max(0, Date.now() - queuedAtMs)
        : 0,
    });

    const startedAt = Date.now();
    try {
      const result = await this.invokeGraph(
        {
          job: input.job,
          allowReclaim: input.allowReclaim,
          retryNumber,
          progress: 0,
          visualScenes: [],
          visualReady: false,
          transcriptReady: false,
          warnings: [],
        },
        {
          configurable: {
            thread_id: [
              input.job.reelId,
              input.job.indexAttemptId,
              input.job.indexVersion,
            ].join(':'),
          },
        },
      );
      if (!result.status) {
        throw new Error('Reel indexing workflow ended without a status');
      }
      if (result.status === 'COMPLETED') {
        this.indexingMetrics.record({
          job: input.job,
          retryNumber,
          stage: 'TOTAL_PIPELINE',
          success: true,
          durationMs: Date.now() - startedAt,
          ...(result.indexCompletion
            ? {
                itemCounts: {
                  reelDocuments: result.indexCompletion.reelDocumentCount,
                  sections: result.indexCompletion.sectionCount,
                  chunks: result.indexCompletion.chunkCount,
                },
              }
            : {}),
        });
      }
      return result.status;
    } catch (error) {
      this.indexingMetrics.record({
        job: input.job,
        retryNumber,
        stage: 'TOTAL_PIPELINE',
        success: false,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private buildGraph() {
    const timed =
      (
        stage: string,
        handler: (
          state: ReelIndexGraphState,
        ) =>
          | Promise<Partial<ReelIndexGraphState>>
          | Partial<ReelIndexGraphState>,
      ) =>
      async (state: unknown): Promise<Partial<ReelIndexGraphState>> => {
        const value = state as ReelIndexGraphState;
        const startedAt = Date.now();
        try {
          const result = await handler(value);
          this.indexingMetrics.record({
            job: value.job,
            retryNumber: value.retryNumber,
            stage,
            success: true,
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          this.indexingMetrics.record({
            job: value.job,
            retryNumber: value.retryNumber,
            stage,
            success: false,
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      };

    return new StateGraph(ReelIndexGraphStateSchema)
      .addNode(
        'load_or_resume_attempt',
        timed('LOAD_OR_RESUME_ATTEMPT', (state) => this.loadOrResume(state)),
      )
      .addNode(
        'validate_and_classify',
        timed('VALIDATE_AND_CLASSIFY', (state) =>
          this.validateAndClassify(state),
        ),
      )
      .addNode(
        'analyze_visual_frames',
        timed('ANALYZE_VISUAL_FRAMES', (state) =>
          this.analyzeVisualEvidence(state),
        ),
      )
      .addNode(
        'build_metadata_only_index',
        timed('BUILD_METADATA_ONLY_INDEX', (state) =>
          this.buildMetadataOnlyIndex(state),
        ),
      )
      .addNode(
        'transcribe_short_video',
        timed('TRANSCRIBE_SHORT_VIDEO', (state) =>
          this.transcribeShortVideo(state),
        ),
      )
      .addNode(
        'load_audio_manifest',
        timed('LOAD_AUDIO_MANIFEST', (state) =>
          this.stageNode(state, 'load_audio_manifest', 15),
        ),
      )
      .addNode(
        'transcribe_pending_segments',
        timed('TRANSCRIBE_PENDING_SEGMENTS', (state) =>
          this.transcribePendingSegments(state),
        ),
      )
      .addNode(
        'merge_transcript_segments',
        timed('MERGE_TRANSCRIPT_SEGMENTS', (state) =>
          this.mergeTranscriptSegments(state),
        ),
      )
      .addNode(
        'validate_transcript',
        timed('VALIDATE_TRANSCRIPT', (state) => this.validateTranscript(state)),
      )
      .addNode(
        'evidence_ready_join',
        timed('EVIDENCE_READY_JOIN', () => ({})),
      )
      .addNode(
        'evaluate_metadata_quality',
        timed('EVALUATE_METADATA_QUALITY', (state) =>
          this.evaluateMetadataQuality(state),
        ),
      )
      .addNode(
        'preserve_user_metadata',
        timed('PRESERVE_USER_METADATA', (state) =>
          this.preserveUserMetadata(state),
        ),
      )
      .addNode(
        'extract_hierarchical_metadata',
        timed('EXTRACT_HIERARCHICAL_METADATA', (state) =>
          this.extractHierarchicalMetadata(state),
        ),
      )
      .addNode(
        'choose_chunking_strategy',
        timed('CHOOSE_CHUNKING_STRATEGY', (state) =>
          this.chooseChunkingStrategy(state),
        ),
      )
      .addNode(
        'build_metadata_document',
        timed('BUILD_METADATA_DOCUMENT', (state) =>
          this.buildDocumentDrafts(state, []),
        ),
      )
      .addNode(
        'build_short_evidence_chunks',
        timed('BUILD_SHORT_EVIDENCE_CHUNKS', (state) =>
          this.buildDocumentDrafts(state, []),
        ),
      )
      .addNode(
        'detect_long_sections',
        timed('DETECT_LONG_SECTIONS', (state) =>
          this.detectLongSections(state),
        ),
      )
      .addNode(
        'section_quality_gate',
        timed('SECTION_QUALITY_GATE', (state) =>
          this.sectionQualityGate(state),
        ),
      )
      .addNode(
        'build_long_evidence_chunks',
        timed('BUILD_LONG_EVIDENCE_CHUNKS', (state) =>
          this.buildLongDocumentDrafts(state),
        ),
      )
      .addNode(
        'validate_document_tokens',
        timed('VALIDATE_DOCUMENT_TOKENS', (state) =>
          this.validateDocumentTokens(state),
        ),
      )
      .addNode(
        'generate_missing_embeddings',
        timed('GENERATE_MISSING_EMBEDDINGS', (state) =>
          this.generateMissingEmbeddings(state),
        ),
      )
      .addNode(
        'embedding_quality_gate',
        timed('EMBEDDING_QUALITY_GATE', (state) =>
          this.embeddingQualityGate(state),
        ),
      )
      .addNode(
        'validate_index_candidate',
        timed('VALIDATE_INDEX_CANDIDATE', (state) =>
          this.validateIndexCandidate(state),
        ),
      )
      .addNode(
        'persist_semantic_candidate',
        timed('PERSIST_SEMANTIC_CANDIDATE', (state) =>
          this.persistSemanticCandidate(state),
        ),
      )
      .addNode(
        'persisted_candidate_integrity_gate',
        timed('PERSISTED_CANDIDATE_INTEGRITY_GATE', (state) =>
          this.persistedCandidateIntegrityGate(state),
        ),
      )
      .addNode(
        'commit_semantic_candidate',
        timed('COMMIT_SEMANTIC_CANDIDATE', (state) =>
          this.commitSemanticCandidate(state),
        ),
      )
      .addEdge(START, 'load_or_resume_attempt')
      .addConditionalEdges(
        'load_or_resume_attempt',
        (state) =>
          (state as ReelIndexGraphState).status ? END : 'validate_and_classify',
        ['validate_and_classify', END],
      )
      .addConditionalEdges(
        'validate_and_classify',
        (state) => {
          const route = (state as ReelIndexGraphState).route;
          const transcriptNode =
            route === 'NO_AUDIO'
              ? 'build_metadata_only_index'
              : route === 'SHORT'
                ? 'transcribe_short_video'
                : 'load_audio_manifest';
          return ['analyze_visual_frames', transcriptNode];
        },
        [
          'analyze_visual_frames',
          'build_metadata_only_index',
          'transcribe_short_video',
          'load_audio_manifest',
        ],
      )
      .addEdge('analyze_visual_frames', 'evidence_ready_join')
      .addEdge('build_metadata_only_index', 'evidence_ready_join')
      .addEdge('transcribe_short_video', 'validate_transcript')
      .addEdge('load_audio_manifest', 'transcribe_pending_segments')
      .addEdge('transcribe_pending_segments', 'merge_transcript_segments')
      .addEdge('merge_transcript_segments', 'validate_transcript')
      .addEdge('validate_transcript', 'evidence_ready_join')
      .addConditionalEdges(
        'evidence_ready_join',
        (state) => {
          const value = state as ReelIndexGraphState;
          return value.visualReady && value.transcriptReady
            ? 'evaluate_metadata_quality'
            : END;
        },
        ['evaluate_metadata_quality', END],
      )
      .addConditionalEdges(
        'evaluate_metadata_quality',
        (state) =>
          (state as ReelIndexGraphState).metadataQuality === 'strong'
            ? 'preserve_user_metadata'
            : 'extract_hierarchical_metadata',
        ['preserve_user_metadata', 'extract_hierarchical_metadata'],
      )
      .addEdge('preserve_user_metadata', 'choose_chunking_strategy')
      .addEdge('extract_hierarchical_metadata', 'choose_chunking_strategy')
      .addConditionalEdges(
        'choose_chunking_strategy',
        (state) => {
          const strategy = (state as ReelIndexGraphState).chunkingStrategy;
          if (strategy === 'metadata-only') return 'build_metadata_document';
          if (strategy === 'short') return 'build_short_evidence_chunks';
          return 'detect_long_sections';
        },
        [
          'build_metadata_document',
          'build_short_evidence_chunks',
          'detect_long_sections',
        ],
      )
      .addEdge('detect_long_sections', 'section_quality_gate')
      .addEdge('section_quality_gate', 'build_long_evidence_chunks')
      .addEdge('build_metadata_document', 'validate_document_tokens')
      .addEdge('build_short_evidence_chunks', 'validate_document_tokens')
      .addEdge('build_long_evidence_chunks', 'validate_document_tokens')
      .addEdge('validate_document_tokens', 'generate_missing_embeddings')
      .addEdge('generate_missing_embeddings', 'embedding_quality_gate')
      .addEdge('embedding_quality_gate', 'validate_index_candidate')
      .addEdge('validate_index_candidate', 'persist_semantic_candidate')
      .addEdge(
        'persist_semantic_candidate',
        'persisted_candidate_integrity_gate',
      )
      .addEdge(
        'persisted_candidate_integrity_gate',
        'commit_semantic_candidate',
      )
      .addEdge('commit_semantic_candidate', END);
  }

  private async loadOrResume(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const existing = await this.checkpoints.get(state.job.indexAttemptId);
    if (existing?.status === 'COMPLETED') return { status: 'DUPLICATE' };
    const claimed = await this.content.claimIndexingAttempt({
      reelId: state.job.reelId,
      indexAttemptId: state.job.indexAttemptId,
      allowReclaim: state.allowReclaim || Boolean(existing),
    });
    if (!claimed) return { status: 'STALE' };
    await this.checkpoints.startOrResume(state.job);
    return this.stageNode(state, 'load_or_resume_attempt', 5);
  }

  private async validateAndClassify(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    let hasAudio = state.job.sourceHasAudio;
    if (hasAudio === undefined) {
      if (!state.job.transcriptionAudioManifestKey) {
        throw new Error('Index job has no verified audio metadata');
      }
      const manifest = await this.storage.getTranscriptionAudioManifest(
        state.job.transcriptionAudioManifestKey,
      );
      hasAudio = manifest.artifacts.length > 0;
    }
    return {
      route: routeIndexing({
        hasAudio,
        durationMs: state.job.outputDurationMs ?? state.job.sourceDurationMs,
        sourceLengthClass: state.job.sourceLengthClass,
        shortMaximumSeconds: this.positiveNumber(
          'MEDIA_SHORT_MAX_DURATION_SECONDS',
          180,
        ),
      }),
      currentStage: 'validate_and_classify',
    };
  }

  private async analyzeVisualEvidence(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    return {
      visualScenes: await this.analyzeVisualFrames.execute(state.job),
      visualReady: true,
    };
  }

  private async buildMetadataOnlyIndex(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    await this.checkpoints.setStage(
      state.job.indexAttemptId,
      'EXTRACTING_METADATA',
      { sections: [] },
    );
    return {
      ...(await this.stageNode(state, 'build_metadata_only_index', 40)),
      transcriptReady: true,
    };
  }

  private async transcribeShortVideo(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    if (!checkpoint.mergedSegments && !checkpoint.mergedTranscript) {
      const transcription = await this.transcribeAudio.execute(state.job);
      const merged = this.mergeTranscript.execute(
        transcription.segments,
        transcription.manifest?.artifacts.length ?? 0,
      );
      await this.checkpoints.setStage(
        state.job.indexAttemptId,
        'MERGING_TRANSCRIPT',
        {
          mergedTranscript: merged.text,
          mergedSegments: merged.segments,
          mergedTranscriptHash: merged.transcriptHash,
          mergeAlgorithmVersion: merged.mergeAlgorithmVersion,
        },
      );
    }
    return this.stageNode(state, 'transcribe_short_video', 35);
  }

  private async transcribePendingSegments(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    await this.stage(
      state.job,
      'TRANSCRIBING_AUDIO_SEGMENTS',
      'transcribe_pending_segments',
      25,
    );
    await this.transcribeAudio.execute(state.job);
    return { currentStage: 'transcribe_pending_segments', progress: 25 };
  }

  private async mergeTranscriptSegments(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    if (!checkpoint.mergedSegments && !checkpoint.mergedTranscript) {
      const segments = await this.checkpoints.listAudioSegments(
        state.job.indexAttemptId,
      );
      const merged = this.mergeTranscript.execute(segments, segments.length);
      await this.checkpoints.setStage(
        state.job.indexAttemptId,
        'MERGING_TRANSCRIPT',
        {
          mergedTranscript: merged.text,
          mergedSegments: merged.segments,
          mergedTranscriptHash: merged.transcriptHash,
          mergeAlgorithmVersion: merged.mergeAlgorithmVersion,
        },
      );
    }
    return this.stageNode(state, 'merge_transcript_segments', 35);
  }

  private async validateTranscript(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    if (
      state.route !== 'NO_AUDIO' &&
      !checkpoint.mergedTranscript?.trim() &&
      !checkpoint.mergedSegments?.length
    ) {
      throw new Error('Audio Reel produced no verified transcript');
    }
    return {
      ...(await this.stageNode(state, 'validate_transcript', 40)),
      transcriptReady: true,
    };
  }

  private evaluateMetadataQuality(
    state: ReelIndexGraphState,
  ): Partial<ReelIndexGraphState> {
    const strong = Boolean(
      (state.job.title?.trim().length ?? 0) >= 8 &&
      (state.job.description?.trim().length ?? 0) >= 40 &&
      state.job.tags.filter((tag) => tag.trim()).length >= 3,
    );
    return {
      metadataQuality: strong ? 'strong' : 'weak',
      currentStage: 'evaluate_metadata_quality',
    };
  }

  private async preserveUserMetadata(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const metadata = {
      title: state.job.title?.trim() || undefined,
      description: state.job.description?.trim() || undefined,
      tags: [
        ...new Set(state.job.tags.map((tag) => tag.trim()).filter(Boolean)),
      ],
    };
    await this.checkpoints.setStage(
      state.job.indexAttemptId,
      'EXTRACTING_METADATA',
      { extractedMetadata: metadata },
    );
    return this.stageNode(state, 'preserve_user_metadata', 50);
  }

  private async extractHierarchicalMetadata(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    if (!checkpoint.extractedMetadata) {
      const initialSections = this.buildSections.execute(
        checkpoint.mergedTranscript,
        checkpoint.mergedSegments,
      );
      const extracted = await this.extractMetadata.execute(
        state.job,
        checkpoint.mergedTranscript,
        initialSections,
      );
      await this.checkpoints.setStage(
        state.job.indexAttemptId,
        'EXTRACTING_METADATA',
        {
          extractedMetadata: extracted.metadata,
          sections: extracted.sections,
        },
      );
    }
    return this.stageNode(state, 'extract_hierarchical_metadata', 50);
  }

  private chooseChunkingStrategy(
    state: ReelIndexGraphState,
  ): Partial<ReelIndexGraphState> {
    return {
      chunkingStrategy:
        state.route === 'NO_AUDIO'
          ? 'metadata-only'
          : state.route === 'LONG'
            ? 'long'
            : 'short',
      currentStage: 'choose_chunking_strategy',
    };
  }

  private async buildDocumentDrafts(
    state: ReelIndexGraphState,
    sections: [],
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const metadata = this.requireMetadata(checkpoint.extractedMetadata);
    const drafts = this.buildIndex.buildDocumentDrafts({
      job: state.job,
      transcript: checkpoint.mergedTranscript,
      transcriptSegments: checkpoint.mergedSegments,
      metadata,
      sections,
      visualScenes: state.visualScenes,
    });
    await this.checkpoints.setStage(
      state.job.indexAttemptId,
      'BUILDING_CHUNKS',
      {
        sections,
        documentDrafts: drafts,
      },
    );
    return this.stageNode(state, 'build_evidence_documents', 70);
  }

  private async detectLongSections(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const candidateSections = await this.buildAdaptiveSections.execute(
      checkpoint.mergedSegments ?? [],
    );
    if (!candidateSections.length) {
      throw new Error('Long transcript produced no semantic sections');
    }
    return {
      candidateSections,
      ...(await this.stageNode(state, 'detect_long_sections', 58)),
    };
  }

  private async sectionQualityGate(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const fallback = this.buildSections.execute(
      checkpoint.mergedTranscript,
      checkpoint.mergedSegments,
    );
    const selection = this.selectHealthySections.execute({
      candidate: state.candidateSections ?? [],
      fallback,
      sourceSegments: checkpoint.mergedSegments ?? [],
      minimumSeconds: this.positiveNumber(
        'INDEX_LONG_SECTION_MIN_SECONDS',
        120,
      ),
      maximumSeconds: this.positiveNumber(
        'INDEX_LONG_SECTION_MAX_SECONDS',
        480,
      ),
    });

    await this.checkpoints.setStage(
      state.job.indexAttemptId,
      'BUILDING_SECTIONS',
      { sections: selection.sections },
    );

    return {
      ...(await this.stageNode(state, 'section_quality_gate', 60)),
      warnings: selection.usedFallback
        ? [
            ...state.warnings,
            `Adaptive sectioning fallback used: ${selection.reason ?? 'quality gate failed'}`,
          ]
        : state.warnings,
    };
  }

  private async buildLongDocumentDrafts(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const sections = checkpoint.sections ?? [];
    const drafts = this.buildIndex.buildDocumentDrafts({
      job: state.job,
      transcript: checkpoint.mergedTranscript,
      transcriptSegments: checkpoint.mergedSegments,
      metadata: this.requireMetadata(checkpoint.extractedMetadata),
      sections,
      visualScenes: state.visualScenes,
    });
    await this.checkpoints.setStage(
      state.job.indexAttemptId,
      'BUILDING_CHUNKS',
      { documentDrafts: drafts },
    );
    return this.stageNode(state, 'build_long_evidence_chunks', 70);
  }

  private async validateDocumentTokens(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const drafts = await this.buildIndex.validateDocumentTokens(
      checkpoint.documentDrafts ?? [],
    );
    await this.checkpoints.setStage(state.job.indexAttemptId, 'VALIDATING', {
      documentDrafts: drafts,
    });
    return this.stageNode(state, 'validate_document_tokens', 75);
  }

  private async generateMissingEmbeddings(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    await this.buildIndex.generateMissingEmbeddings(
      checkpoint.documentDrafts ?? [],
    );
    return this.stageNode(state, 'generate_missing_embeddings', 85);
  }

  private async embeddingQualityGate(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const documents = await this.buildIndex.materializeDocuments(
      checkpoint.documentDrafts ?? [],
    );
    this.validateEmbeddingQuality.execute({
      documents,
      expectedDimensions: documents[0]?.embeddingDimensions,
      maxDuplicateRatio: this.fraction(
        'INDEX_EMBEDDING_MAX_DUPLICATE_RATIO',
        0.5,
      ),
    });
    return this.stageNode(state, 'embedding_quality_gate', 88);
  }

  private async validateIndexCandidate(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const documents = await this.buildIndex.materializeDocuments(
      checkpoint.documentDrafts ?? [],
    );
    this.validateCandidate.execute({
      job: state.job,
      documents,
      transcriptSegments: checkpoint.mergedSegments,
    });
    return this.stageNode(state, 'validate_index_candidate', 90);
  }

  private async persistSemanticCandidate(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const documents = await this.buildIndex.materializeDocuments(
      checkpoint.documentDrafts ?? [],
    );
    await this.semanticIndex.persistCandidate({
      job: state.job,
      metadata: this.requireMetadata(checkpoint.extractedMetadata),
      transcriptSegments: checkpoint.mergedSegments,
      documents,
    });
    await this.checkpoints.setStage(state.job.indexAttemptId, 'PERSISTING');
    return {
      ...(await this.stageNode(state, 'persist_semantic_candidate', 95)),
      indexCompletion: this.toCompletionCommand(
        state.job,
        documents,
        checkpoint.mergedTranscript,
        checkpoint.mergedSegments,
      ),
    };
  }

  private async persistedCandidateIntegrityGate(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    const checkpoint = await this.requireCheckpoint(state);
    const documents = await this.buildIndex.materializeDocuments(
      checkpoint.documentDrafts ?? [],
    );
    await this.validatePersistedCandidate.execute({
      job: state.job,
      documents,
      transcriptSegmentCount: checkpoint.mergedSegments?.length ?? 0,
    });
    return this.stageNode(state, 'persisted_candidate_integrity_gate', 97);
  }

  private async commitSemanticCandidate(
    state: ReelIndexGraphState,
  ): Promise<Partial<ReelIndexGraphState>> {
    if (!state.indexCompletion) {
      throw new Error('Semantic index completion summary is missing');
    }

    const status = await this.commitCandidate.execute({
      job: state.job,
      completion: state.indexCompletion,
    });

    return {
      status,
      currentStage:
        status === 'COMPLETED'
          ? 'commit_semantic_candidate'
          : 'stale_semantic_candidate',
      progress: status === 'COMPLETED' ? 100 : state.progress,
    };
  }

  private toCompletionCommand(
    job: ReelIndexJob,
    documents: ReelIndexDocument[],
    transcript?: string,
    transcriptSegments?: CompleteReelIndexCommand['transcriptSegments'],
  ): CompleteReelIndexCommand {
    const reelDocument = documents.find((document) => document.kind === 'REEL');
    if (!reelDocument) throw new Error('Semantic Reel document is missing');
    return {
      reelId: job.reelId,
      indexAttemptId: job.indexAttemptId,
      indexVersion: job.indexVersion,
      reelDocumentCount: documents.filter(
        (document) => document.kind === 'REEL',
      ).length,
      sectionCount: documents.filter((document) => document.kind === 'SECTION')
        .length,
      chunkCount: documents.filter((document) => document.kind === 'CHUNK')
        .length,
      embeddingProvider: reelDocument.embeddingProvider,
      embeddingModel: reelDocument.embeddingModel,
      embeddingDimensions: reelDocument.embeddingDimensions,
      embeddingVersion: reelDocument.embeddingVersion,
      indexedAt: new Date().toISOString(),
      transcript,
      transcriptSegments,
    };
  }

  private async stageNode(
    state: ReelIndexGraphState,
    currentStage: string,
    progress: number,
  ): Promise<Partial<ReelIndexGraphState>> {
    await this.content.reportProgress({
      reelId: state.job.reelId,
      indexAttemptId: state.job.indexAttemptId,
      stage: this.checkpointStage(currentStage),
      progress,
    });
    return { currentStage, progress };
  }

  private async stage(
    job: ReelIndexJob,
    stage: IndexCheckpointStage,
    currentStage: string,
    progress: number,
  ): Promise<void> {
    await this.checkpoints.setStage(job.indexAttemptId, stage);
    await this.content.reportProgress({
      reelId: job.reelId,
      indexAttemptId: job.indexAttemptId,
      stage,
      progress,
    });
  }

  private checkpointStage(currentStage: string): IndexCheckpointStage {
    if (currentStage.includes('transcrib'))
      return 'TRANSCRIBING_AUDIO_SEGMENTS';
    if (currentStage.includes('merge')) return 'MERGING_TRANSCRIPT';
    if (currentStage.includes('metadata')) return 'EXTRACTING_METADATA';
    if (currentStage.includes('section')) return 'BUILDING_SECTIONS';
    if (currentStage.includes('embedding')) return 'EMBEDDING';
    if (currentStage.includes('persist') || currentStage.includes('commit')) {
      return 'PERSISTING';
    }
    if (currentStage.includes('validat') || currentStage.includes('quality')) {
      return 'VALIDATING';
    }
    return 'BUILDING_CHUNKS';
  }

  private async requireCheckpoint(state: ReelIndexGraphState) {
    const checkpoint = await this.checkpoints.get(state.job.indexAttemptId);
    if (!checkpoint) {
      throw new Error(
        `Indexing attempt ${state.job.indexAttemptId} is missing`,
      );
    }
    return checkpoint;
  }

  private requireMetadata<T>(metadata: T | undefined): T {
    if (!metadata) throw new Error('Indexing metadata is missing');
    return metadata;
  }

  private positiveNumber(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private fraction(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  }
}
