/**
 * Asks a stronger model whether transcript excerpts state the answer to a question. Used only where the vector
 * distance is just past the "not covered" limit, to keep a covered question whose excerpt is phrased far from it
 * (another language, transcription errors) from being refused.
 */
export interface IEvidenceAnswerCheck {
  /** True when the excerpts answer the question, false when they do not, undefined when it cannot tell. */
  answersQuestion(
    question: string,
    excerpts: string[],
  ): Promise<boolean | undefined>;
  /** Closest-excerpt distance up to which a refusal may be lifted by the check; undefined when the check is off. */
  rescueMaxDistance(): number | undefined;
}
