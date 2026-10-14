import {
  fingerprintCreateReelRequest,
  normalizeCreateReelRequest,
} from './publish-request-fingerprint';

describe('publish request fingerprint', () => {
  it('normalizes request formatting and includes client duration', () => {
    const first = {
      mediaKey: '/reels/user-1/source.mp4',
      title: ' Title ',
      description: ' Description ',
      tags: ['#Tag', 'tag'],
      visibility: 'public' as const,
      clientObservedDurationMs: 12_345.6789,
    };
    const second = {
      ...first,
      mediaKey: 'reels/user-1/source.mp4',
      title: 'Title',
      description: 'Description',
      tags: ['tag'],
      clientObservedDurationMs: 12_345.679,
    };

    expect(normalizeCreateReelRequest(first)).toEqual(
      normalizeCreateReelRequest(second),
    );
    expect(fingerprintCreateReelRequest(first)).toBe(
      fingerprintCreateReelRequest(second),
    );
    expect(
      fingerprintCreateReelRequest({
        ...second,
        clientObservedDurationMs: 12_346,
      }),
    ).not.toBe(fingerprintCreateReelRequest(second));
  });
});
