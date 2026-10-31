import { ConfigService } from '@nestjs/config';
import { OllamaHttpError, OllamaTextClient } from './ollama-text.client';

describe('OllamaTextClient', () => {
  const client = new OllamaTextClient(
    new ConfigService({ OLLAMA_TEXT_BASE_URL: 'http://ollama.test:11434/' }),
  );
  afterEach(() => jest.restoreAllMocks());

  it('sends native Ollama chat options and validates the response', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: { content: '{"ok":true}' }, done: true }),
        ),
      );
    await expect(
      client.chat({
        model: 'gemma4',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 300,
        temperature: 0,
        format: { type: 'object' },
      }),
    ).resolves.toMatchObject({ message: { content: '{"ok":true}' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama.test:11434/api/chat');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'gemma4',
      think: false,
      stream: false,
      format: { type: 'object' },
      options: { num_predict: 300, temperature: 0 },
    });
  });

  it('reassembles split NDJSON chunks and emits each streamed token', async () => {
    const encoder = new TextEncoder();
    const frames = [
      '{"message":{"content":"Hel"},"done":false}\n{"message":',
      '{"content":"lo"},"done":false}\n{"done":true,"done_reason":"stop"}\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            frames.forEach((frame) =>
              controller.enqueue(encoder.encode(frame)),
            );
            controller.close();
          },
        }),
      ),
    );
    const onToken = jest.fn();
    await expect(
      client.chat({ model: 'gemma4', messages: [], onToken }),
    ).resolves.toMatchObject({
      message: { content: 'Hello' },
      done_reason: 'stop',
    });
    expect(onToken.mock.calls).toEqual([['Hel'], ['lo']]);
  });

  it('rejects unfinished streams and surfaces provider status', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('{"message":{"content":"partial"},"done":false}\n'),
      )
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(
      client.chat({ model: 'gemma4', messages: [], onToken: jest.fn() }),
    ).rejects.toMatchObject({ code: 'OLLAMA_INVALID_RESPONSE' });
    await expect(
      client.chat({ model: 'gemma4', messages: [] }),
    ).rejects.toBeInstanceOf(OllamaHttpError);
  });
});
