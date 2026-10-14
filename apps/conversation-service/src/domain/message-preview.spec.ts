import { MESSAGE_PREVIEW_MAX_LENGTH, truncatePreview } from './message-preview';

describe('truncatePreview', () => {
  it('keeps short previews and passes through missing ones', () => {
    expect(truncatePreview('hello')).toBe('hello');
    expect(
      truncatePreview('x'.repeat(MESSAGE_PREVIEW_MAX_LENGTH)),
    ).toHaveLength(MESSAGE_PREVIEW_MAX_LENGTH);
    expect(truncatePreview(null)).toBeNull();
    expect(truncatePreview(undefined)).toBeNull();
  });

  it('cuts long text to the limit with an ellipsis', () => {
    const preview = truncatePreview('a'.repeat(5000))!;

    expect(Array.from(preview)).toHaveLength(MESSAGE_PREVIEW_MAX_LENGTH);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const preview = truncatePreview(
      '😀'.repeat(MESSAGE_PREVIEW_MAX_LENGTH + 50),
    )!;

    expect(Array.from(preview)).toHaveLength(MESSAGE_PREVIEW_MAX_LENGTH);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(preview).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
