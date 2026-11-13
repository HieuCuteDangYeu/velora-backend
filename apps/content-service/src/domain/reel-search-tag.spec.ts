import { normalizeReelSearchTag } from '@content/domain/reel-search-tag';

describe('normalizeReelSearchTag', () => {
  it.each([
    ['#Garena', 'garena'],
    ['  Corporate_Humor ', 'corporate humor'],
    ['##dance--battle', 'dance battle'],
    ['Việt Nam', 'việt nam'],
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizeReelSearchTag(raw)).toBe(expected);
  });

  it.each(['', '#', 'a', '12345', 'x'.repeat(33)])(
    'rejects unusable tag %p',
    (raw) => {
      expect(normalizeReelSearchTag(raw)).toBeNull();
    },
  );
});
