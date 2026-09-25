import { CallSession } from '../../domain/entities/call-session.entity';
import {
  getSessionExpiryDate,
  getSessionRingTimeoutMs,
} from '../../domain/call-lifecycle-config';

const CLIENT_TERMINAL_REASONS = new Set([
  'ended',
  'left',
  'cancelled',
  'disconnected',
  'app_closed',
  'timeout',
  'rejected',
  'busy',
  'mic_permission_denied',
  'camera_permission_denied',
  'media_unavailable',
  'remote_audio_not_ready',
  'remote_accept_failed',
]);

export const normalizeClientTerminalReason = (reason?: string) =>
  reason && CLIENT_TERMINAL_REASONS.has(reason) ? reason : undefined;

export function buildCallLifecycleMetadata(session: CallSession, now: Date) {
  const ringTimeoutMs = getSessionRingTimeoutMs(session.ringTimeoutMs);
  const lifecycleRevision =
    Number.isInteger(session.lifecycleRevision) &&
    session.lifecycleRevision >= 0
      ? session.lifecycleRevision
      : undefined;

  return {
    recipientUserId: session.targetUserId,
    invitedUserIds: session.invitedUserIds,
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
