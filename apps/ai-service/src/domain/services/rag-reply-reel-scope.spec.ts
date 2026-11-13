import { scopeAccessibleReelsToReplyTarget } from '@ai/domain/services/rag-reply-reel-scope';

describe('scopeAccessibleReelsToReplyTarget', () => {
  const accessible = ['reel-a', 'reel-b', 'reel-c'];

  it('narrows to the replied-to reel when it is accessible', () => {
    expect(scopeAccessibleReelsToReplyTarget(accessible, 'reel-b')).toEqual([
      'reel-b',
    ]);
  });

  it('ignores a reply target that is not already accessible in the conversation', () => {
    expect(scopeAccessibleReelsToReplyTarget(accessible, 'reel-z')).toEqual(
      accessible,
    );
  });

  it('keeps everything when there is no reply target', () => {
    expect(scopeAccessibleReelsToReplyTarget(accessible, undefined)).toEqual(
      accessible,
    );
    expect(scopeAccessibleReelsToReplyTarget(accessible, '  ')).toEqual(
      accessible,
    );
  });

  it('never invents access when nothing is accessible', () => {
    expect(scopeAccessibleReelsToReplyTarget([], 'reel-a')).toEqual([]);
  });
});
