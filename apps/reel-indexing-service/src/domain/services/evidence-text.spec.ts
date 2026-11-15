import { normalizeEvidenceText } from './evidence-text';

describe('normalizeEvidenceText', () => {
  it('removes spaces between Chinese characters and words', () => {
    expect(normalizeEvidenceText('我 走 叔 叔 请 不 吝 点 赞')).toBe(
      '我走叔叔请不吝点赞',
    );
    expect(normalizeEvidenceText('你们  可以 支持 郡主')).toBe(
      '你们可以支持郡主',
    );
  });

  it('removes spaces between Japanese kana and kanji', () => {
    expect(normalizeEvidenceText('私 は 学生 です')).toBe('私は学生です');
  });

  it('keeps the spaces around Latin text and numbers', () => {
    expect(normalizeEvidenceText('是 OK 吧 第 3 集')).toBe('是 OK 吧第 3 集');
    expect(normalizeEvidenceText('The dog sent a message')).toBe(
      'The dog sent a message',
    );
  });

  it('keeps spaces between Korean words', () => {
    expect(normalizeEvidenceText('안녕하세요 여러분')).toBe(
      '안녕하세요 여러분',
    );
  });

  it('still trims and collapses whitespace like before', () => {
    expect(normalizeEvidenceText('  a \n b\t c ')).toBe('a b c');
  });
});
