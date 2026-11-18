export interface IChatImageStorageService {
  /**
   * Reads one chat image by storage key. Throws ChatImageUnreadableError when the object is
   * missing or larger than `maxBytes`; the size is checked before the body is read.
   */
  downloadImage(key: string, maxBytes: number): Promise<Buffer>;
}
