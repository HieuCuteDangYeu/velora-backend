export interface IPasswordResetCodeStore {
  /** Replaces any earlier code for this user and resets the wrong-guess count. */
  issue(userId: string, code: string, ttlSeconds: number): Promise<void>;
  /**
   * True when `code` is this user's live code. A wrong guess counts against the
   * code, which is deleted once too many wrong guesses are made. With `consume`,
   * a correct code is deleted so it works only once.
   */
  check(
    userId: string,
    code: string,
    options: { consume: boolean },
  ): Promise<boolean>;
}
