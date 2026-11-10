/**
 * Port that decides whether a chat turn may start now, wait briefly, or must be turned away.
 * `run` executes the task once admitted and releases its slot when it settles. It rejects
 * with ChatBusyError when the turn cannot be admitted in time.
 */
export interface IChatAdmission {
  run<T>(task: () => Promise<T>): Promise<T>;
}
