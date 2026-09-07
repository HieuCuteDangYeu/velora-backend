export interface TwoHopFriendCandidateEvidence {
  userId: string;
  mutualFriendCount: number;
  adamicAdarScore: number;
}

export interface IFriendGraphRepository {
  listRelationshipUserIds(userId: string): Promise<string[]>;

  findTwoHopCandidates(
    userId: string,
  ): Promise<TwoHopFriendCandidateEvidence[]>;
}
