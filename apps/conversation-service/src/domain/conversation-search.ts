import type { ChatParticipant } from './entities/conversation.entity';

/** Longest search text the service accepts. */
export const CONVERSATION_SEARCH_MAX_LENGTH = 100;

/**
 * Folds text the way people type it: no accents, "đ" as "d", lower case. Matches the mobile
 * app's own normalisation so an offline filter and the server agree.
 */
export const normalizeConversationSearchText = (
  value: string | null | undefined,
): string =>
  (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim()
    .slice(0, CONVERSATION_SEARCH_MAX_LENGTH);

type SearchableParticipant = ChatParticipant & { username?: string | null };

const participantSearchTexts = (participant: SearchableParticipant) => [
  participant.name,
  participant.fullName,
  participant.username,
  participant.email?.split('@')[0],
];

/**
 * The people whose profiles decide whether a conversation matches: nobody for a named group (its
 * name decides), the other members otherwise. Lets a search skip looking up everyone it scans.
 */
export const participantIdsNeededToMatch = (
  conversation: {
    isGroup: boolean;
    name?: string | null;
    participantIds: string[];
  },
  viewerId: string,
): string[] => {
  if (conversation.isGroup && conversation.name?.trim()) return [];

  const others = conversation.participantIds.filter((id) => id !== viewerId);
  return others.length ? others : conversation.participantIds;
};

/**
 * Whether a conversation answers a search: a group by its name (or by its members when it has no
 * name), a direct chat by the other person's name, username or e-mail handle.
 */
export const conversationMatchesSearch = ({
  conversation,
  participantsById,
  searchTerm,
  viewerId,
}: {
  conversation: {
    isGroup: boolean;
    name?: string | null;
    participantIds: string[];
  };
  participantsById: Map<string, SearchableParticipant>;
  searchTerm: string;
  viewerId: string;
}): boolean => {
  const includesTerm = (text: string | null | undefined) =>
    normalizeConversationSearchText(text).includes(searchTerm);

  if (conversation.isGroup && conversation.name?.trim()) {
    return includesTerm(conversation.name);
  }

  // A chat with yourself has no other member.
  const candidates = participantIdsNeededToMatch(conversation, viewerId);

  return candidates.some((id) => {
    const participant = participantsById.get(id);
    return participant
      ? participantSearchTexts(participant).some(includesTerm)
      : false;
  });
};
