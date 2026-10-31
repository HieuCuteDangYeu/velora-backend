const REEL_MEDIA_KEY_ROOTS = ['reels', 'chat-videos'] as const;

// Evidence-only imported playlists remain bound to this Reel, including immutable versions.
export function isLegacyReelHlsKey(key: string, reelId: string): boolean {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      reelId,
    ) &&
    new RegExp(`^reels/${reelId}/(?:${uuid}/)?master\\.m3u8$`, 'i').test(
      normalizeReelMediaKey(key),
    )
  );
}

export function normalizeReelMediaKey(key: string): string {
  return key.trim().replace(/^\/+/, '');
}

export function isUserOwnedReelMediaKey(key: string, userId: string): boolean {
  const normalizedKey = normalizeReelMediaKey(key);
  const normalizedUserId = userId.trim();

  if (
    normalizedKey.includes('\\') ||
    normalizedKey.split('/').some((part) => part === '.' || part === '..') ||
    normalizedUserId.length === 0 ||
    normalizedUserId.includes('/') ||
    normalizedUserId.includes('\\')
  ) {
    return false;
  }

  return REEL_MEDIA_KEY_ROOTS.some((root) => {
    const ownershipPrefix = `${root}/${normalizedUserId}/`;
    return (
      normalizedKey.startsWith(ownershipPrefix) &&
      normalizedKey.length > ownershipPrefix.length
    );
  });
}
