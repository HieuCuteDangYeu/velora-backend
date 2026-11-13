/**
 * Port for telling a conversation that the Velora AI bot is composing a reply,
 * so clients can show the same typing indicator they show for a person.
 * Both calls are idempotent and best-effort: they must never throw.
 */
export interface IBotTypingNotifier {
  /** Marks the bot as typing in the conversation until `stop` (or a safety cap). */
  start(conversationId: string): void;
  /** Clears the typing state; a no-op when the bot is not typing there. */
  stop(conversationId: string): void;
}
