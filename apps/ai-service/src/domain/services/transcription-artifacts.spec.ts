import {
  removeTranscriptionArtifacts,
  stripTranscriptionArtifactsFromText,
} from './transcription-artifacts';

const words = (...texts: string[]) =>
  texts.map((text, index) => ({
    id: index,
    start: index,
    end: index + 1,
    text,
  }));

describe('removeTranscriptionArtifacts', () => {
  it('drops the invented subscribe line and keeps the speech around it', () => {
    const result = removeTranscriptionArtifacts(
      words(
        ...Array.from('我走叔'),
        ...Array.from('请不吝点赞订阅转发打赏支持明镜与点栏目'),
        ...Array.from('多谢郡主'),
      ),
    );
    expect(result.map((item) => item.text).join('')).toBe('我走叔多谢郡主');
  });

  it('removes the phrase when it is spread across multi-character items', () => {
    const result = removeTranscriptionArtifacts(
      words(
        '你好',
        '请不吝点赞',
        '订阅',
        '转发',
        '打赏支持',
        '明镜与点栏目',
        '再见',
      ),
    );
    expect(result.map((item) => item.text)).toEqual(['你好', '再见']);
  });

  it('removes a repeated subscribe/forward variant and traditional characters', () => {
    expect(
      stripTranscriptionArtifactsFromText(
        '好 请点赞订阅转发订阅转发订阅转发 的',
      ),
    ).toBe('好 的');
    expect(
      removeTranscriptionArtifacts(
        words(...Array.from('請不吝點贊訂閱轉發打賞支持明鏡與點欄目')),
      ),
    ).toEqual([]);
  });

  it('drops the invented Vietnamese subscribe line from word items', () => {
    const line =
      'Hãy subscribe cho kênh Ghiền Mì Gõ Để Không Bỏ Lỡ Những Video Hấp Dẫn';
    const result = removeTranscriptionArtifacts(
      words('cảm', 'ơn', 'các', 'bạn.', ...line.split(' '), ...line.split(' ')),
    );
    expect(result.map((item) => item.text)).toEqual([
      'cảm',
      'ơn',
      'các',
      'bạn.',
    ]);
  });

  it('drops the Vietnamese line with another channel name or spelling', () => {
    expect(
      stripTranscriptionArtifactsFromText(
        'thú vị diễn ra. hãy subscribe cho kênh lalaschool để không bỏ lỡ những video hấp dẫn điều loại',
      ),
    ).toBe('thú vị diễn ra. điều loại');
    expect(
      stripTranscriptionArtifactsFromText(
        'Hãy subcribe cho kênh Ghiền Mì Gõ để không bỏ lỡ những video hấp dẫn.',
      ),
    ).toBe('');
  });

  it('keeps Vietnamese and English speech that only mentions subscribing', () => {
    const speech = [
      'tôi đang ở trong môi trường subscribe của mình.',
      'nhớ đăng ký kênh nhé, video sau sẽ có nhiều điều thú vị',
      'please like and subscribe. it helps these videos find deadheads.',
      'để không bỏ lỡ những video hấp dẫn thì các bạn theo dõi nhé',
    ];
    for (const text of speech) {
      expect(stripTranscriptionArtifactsFromText(text)).toBe(text);
    }
  });

  it('collapses a word repeated eight or more times in a row', () => {
    const result = removeTranscriptionArtifacts(
      words('他', ...Array<string>(9).fill('你'), '来了'),
    );
    expect(result.map((item) => item.text)).toEqual(['他', '你', '来了']);
    expect(result[1]).toMatchObject({ start: 1, end: 10 });
  });

  it('leaves stutters and ordinary text untouched', () => {
    const input = words(
      ...Array<string>(6).fill('醒'),
      '好',
      '点赞',
      '这个',
      '视频',
    );
    expect(removeTranscriptionArtifacts(input)).toEqual(input);
  });

  it('renumbers ids after removal', () => {
    const result = removeTranscriptionArtifacts(
      words('a', '点赞订阅转发', 'b'),
    );
    expect(result.map((item) => item.id)).toEqual([0, 1]);
  });
});
