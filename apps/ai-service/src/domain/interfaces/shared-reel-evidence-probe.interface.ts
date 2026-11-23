/**
 * Asks whether a message is answered by the reels shared in the chat. The router uses it to tell a
 * question about the video apart from a general-knowledge question with the same shape.
 */
export interface ISharedReelEvidenceProbe {
  /** True only when a transcript excerpt of one of the reels is close to the message. Never throws. */
  hasStrongEvidence(input: {
    message: string;
    accessibleReelIds: string[];
  }): Promise<boolean>;
}
