import { CallSession } from '../../domain/entities/call-session.entity';
import {
  getSessionExpiryDate,
  getSessionRingTimeoutMs,
} from '../../domain/call-lifecycle-config';

export function buildCallLifecycleMetadata(session: CallSession, now: Date) {
  const ringTimeoutMs = getSessionRingTimeoutMs(session.ringTimeoutMs);
  const lifecycleRevision =
    Number.isInteger(session.lifecycleRevision) &&
    session.lifecycleRevision >= 0
      ? session.lifecycleRevision
      : undefined;

  return {
    recipientUserId: session.targetUserId,
    initiatorDisplayName: session.initiatorDisplayName ?? 'Incoming call',
    initiatorAvatarUrl: session.initiatorAvatarUrl,
    ringTimeoutMs,
    expiresAt: getSessionExpiryDate(
      session.expiresAt,
      ringTimeoutMs,
      now,
    ).toISOString(),
    ...(lifecycleRevision !== undefined ? { lifecycleRevision } : {}),
  };
}
