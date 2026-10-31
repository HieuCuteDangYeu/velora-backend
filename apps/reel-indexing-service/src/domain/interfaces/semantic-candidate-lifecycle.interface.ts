export interface SemanticCandidateActivation {
  previousIndexAttemptId?: string;
  projectionGeneration?: string;
}

export interface ISemanticCandidateLifecycle {
  isCandidateActive?(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration: string;
    publicationToken?: string;
  }): Promise<boolean>;
  activateCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<SemanticCandidateActivation>;

  rollbackCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    previousIndexAttemptId?: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<void>;

  finalizeCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<void>;

  discardCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<void>;
}
