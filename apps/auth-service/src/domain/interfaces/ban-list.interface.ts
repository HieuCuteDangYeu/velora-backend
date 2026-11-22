/** Fast denylist of banned user ids. The user database is the source of truth. */
export interface IBanList {
  ban(userId: string): Promise<void>;
  unban(userId: string): Promise<void>;
  /** Re-adds a missing entry (and drops the user's open sockets). Returns true if it was missing. */
  ensureBanned(userId: string): Promise<boolean>;
  /** Throws when the store is unreachable so callers can fall back to the database. */
  isBanned(userId: string): Promise<boolean>;
}
