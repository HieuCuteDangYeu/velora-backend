import { ConfigService } from '@nestjs/config';
import { GroqTranscriptionAdapter } from './groq-transcription.adapter';

describe('GroqTranscriptionAdapter timed transcription', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests word timestamps and prefers them over coarse segments', async () => {
    const config = {
      getOrThrow: (key: string) =>
        ({
          AI_TRANSCRIPTION_MODEL: 'whisper-large-v3-turbo',
          GROQ_API_KEY: 'test-key',
        })[key],
      get: (key: string) =>
        ({
          AI_TRANSCRIPTION_VERSION: 'test-v1',
          AI_TRANSCRIPTION_TIMEOUT_MS: '1000',
        })[key],
    } as unknown as ConfigService;
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            text: 'hello world',
            segments: [{ id: 0, start: 0, end: 1, text: 'hello world' }],
            words: [
              { start: 0.1, end: 0.35, word: 'hello' },
              { start: 0.55, end: 0.9, word: 'world' },
            ],
          }),
        ),
    } as Response);

    const result = await new GroqTranscriptionAdapter(config).transcribeAudio(
      Buffer.from('audio'),
    );
    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;

    expect(form.getAll('timestamp_granularities[]')).toEqual([
      'word',
      'segment',
    ]);
    expect(result.segments).toEqual([
      { id: 0, start: 0.1, end: 0.35, text: 'hello' },
      { id: 1, start: 0.55, end: 0.9, text: 'world' },
    ]);
  });

  const adapter = () =>
    new GroqTranscriptionAdapter({
      getOrThrow: () => 'whisper-large-v3-turbo',
      get: (key: string) => ({ AI_TRANSCRIPTION_TIMEOUT_MS: '1000' })[key],
    } as unknown as ConfigService);
  const okResponse = () =>
    ({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ text: 'hi' })),
    }) as Response;

  it('drops the invented subscribe line and collapses a looped word', async () => {
    const chars = (text: string, from: number) =>
      Array.from(text).map((word, index) => ({
        start: from + index,
        end: from + index + 1,
        word,
      }));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            text: '我走请不吝点赞订阅转发打赏支持明镜与点栏目你你你你你你你你来了',
            words: [
              ...chars('我走', 0),
              ...chars('请不吝点赞订阅转发打赏支持明镜与点栏目', 2),
              ...chars('你你你你你你你你来了', 22),
            ],
          }),
        ),
    } as Response);

    const result = await adapter().transcribeAudio(Buffer.from('audio'));

    expect(result.text).toBe('我走 你你你你你你你你来了');
    expect(result.segments?.map((item) => item.text)).toEqual([
      '我',
      '走',
      '你',
      '来',
      '了',
    ]);
  });

  it('uploads Opus audio under its real .ogg name and type', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse());
    await adapter().transcribeAudio(Buffer.from('audio'), {
      fileName: 'audio_000000.ogg',
    });
    const file = (fetchMock.mock.calls[0]?.[1]?.body as FormData).get(
      'file',
    ) as File;
    expect(file.name).toBe('audio_000000.ogg');
    expect(file.type).toBe('audio/ogg');
  });

  it('keeps the audio.wav default when no file name is given', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse());
    await adapter().transcribeAudio(Buffer.from('audio'));
    const file = (fetchMock.mock.calls[0]?.[1]?.body as FormData).get(
      'file',
    ) as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
  });
});
