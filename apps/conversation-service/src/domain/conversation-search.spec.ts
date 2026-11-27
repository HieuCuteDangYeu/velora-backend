import {
  conversationMatchesSearch,
  normalizeConversationSearchText,
  participantIdsNeededToMatch,
} from './conversation-search';

describe('conversation search', () => {
  const participantsById = new Map([
    ['me', { id: 'me', name: 'Me Myself' }],
    ['a', { id: 'a', fullName: 'Lê Anh Quân', email: 'quan.le@example.com' }],
    ['b', { id: 'b', name: 'Đệ Của Anh', username: 'de_anh' }],
  ]);
  const match = (
    conversation: Parameters<
      typeof conversationMatchesSearch
    >[0]['conversation'],
    text: string,
  ) =>
    conversationMatchesSearch({
      conversation,
      participantsById,
      searchTerm: normalizeConversationSearchText(text),
      viewerId: 'me',
    });

  it('folds accents, đ and case', () => {
    expect(normalizeConversationSearchText('  Đệ CỦA Quân ')).toBe(
      'de cua quan',
    );
    expect(normalizeConversationSearchText(undefined)).toBe('');
  });

  it('limits the search text length', () => {
    expect(normalizeConversationSearchText('a'.repeat(500))).toHaveLength(100);
  });

  it('matches a direct chat by the other person, never by the viewer', () => {
    const direct = { isGroup: false, participantIds: ['me', 'a'] };
    expect(match(direct, 'quan')).toBe(true);
    expect(match(direct, 'QUÂN')).toBe(true);
    expect(match(direct, 'quan.le')).toBe(true);
    expect(match(direct, 'myself')).toBe(false);
  });

  it('matches a direct chat by username', () => {
    expect(
      match({ isGroup: false, participantIds: ['me', 'b'] }, 'de_anh'),
    ).toBe(true);
  });

  it('matches a named group by its name only', () => {
    const group = {
      isGroup: true,
      name: 'Nhóm học pilot',
      participantIds: ['me', 'a'],
    };
    expect(match(group, 'nhom hoc')).toBe(true);
    expect(match(group, 'quan')).toBe(false);
  });

  it('falls back to members for an unnamed group', () => {
    expect(
      match({ isGroup: true, participantIds: ['me', 'a', 'b'] }, 'de cua'),
    ).toBe(true);
  });

  it('does not match when the other member is unknown', () => {
    expect(
      match({ isGroup: false, participantIds: ['me', 'ghost'] }, 'ghost'),
    ).toBe(false);
  });

  it('knows whose profiles a match depends on', () => {
    expect(
      participantIdsNeededToMatch(
        { isGroup: true, name: 'Named', participantIds: ['me', 'a'] },
        'me',
      ),
    ).toEqual([]);
    expect(
      participantIdsNeededToMatch(
        { isGroup: true, participantIds: ['me', 'a', 'b'] },
        'me',
      ),
    ).toEqual(['a', 'b']);
    expect(
      participantIdsNeededToMatch(
        { isGroup: false, participantIds: ['me', 'me'] },
        'me',
      ),
    ).toEqual(['me', 'me']);
  });
});
