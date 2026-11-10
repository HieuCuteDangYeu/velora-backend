import { ChatBusyError } from '@ai/domain/errors/chat-busy.error';
import { ConfigService } from '@nestjs/config';
import { InProcessChatAdmissionAdapter } from './in-process-chat-admission.adapter';

const adapterWith = (env: Record<string, string> = {}) =>
  new InProcessChatAdmissionAdapter(new ConfigService(env));

/** A task the test finishes by hand, so it can observe who is running. */
function manualTask(label: string, started: string[]) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return {
    finish,
    task: async () => {
      started.push(label);
      await done;
      return label;
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('InProcessChatAdmissionAdapter', () => {
  it('runs up to the concurrency limit at once and holds the next turn until a slot frees', async () => {
    const adapter = adapterWith({ AI_MAX_CONCURRENT_TURNS: '2' });
    const started: string[] = [];
    const [a, b, c] = ['a', 'b', 'c'].map((l) => manualTask(l, started));
    const results = [a, b, c].map((t) => adapter.run(t.task));
    await tick();
    expect(started).toEqual(['a', 'b']);
    a.finish();
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    b.finish();
    c.finish();
    await expect(Promise.all(results)).resolves.toEqual(['a', 'b', 'c']);
  });

  it('admits waiting turns in arrival order', async () => {
    const adapter = adapterWith({ AI_MAX_CONCURRENT_TURNS: '1' });
    const started: string[] = [];
    const tasks = ['a', 'b', 'c', 'd'].map((l) => manualTask(l, started));
    const results = tasks.map((t) => adapter.run(t.task));
    for (const t of tasks) {
      await tick();
      t.finish();
    }
    await Promise.all(results);
    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses a turn at once, with a retry hint, when the queue is full', async () => {
    const adapter = adapterWith({
      AI_MAX_CONCURRENT_TURNS: '1',
      AI_MAX_QUEUED_TURNS: '1',
    });
    const started: string[] = [];
    const running = manualTask('running', started);
    const queued = manualTask('queued', started);
    const first = adapter.run(running.task);
    const second = adapter.run(queued.task);
    await tick();

    const refused = adapter.run(() => Promise.resolve('never'));
    await expect(refused).rejects.toBeInstanceOf(ChatBusyError);
    await expect(refused).rejects.toMatchObject({ code: 'AI_BUSY' });
    const error = (await refused.catch((e: unknown) => e)) as ChatBusyError;
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(5);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(60);

    running.finish();
    queued.finish();
    await Promise.all([first, second]);
  });

  it('refuses a turn that waited too long and keeps the slot accounting correct', async () => {
    const adapter = adapterWith({
      AI_MAX_CONCURRENT_TURNS: '1',
      AI_TURN_QUEUE_WAIT_MS: '150',
    });
    const started: string[] = [];
    const running = manualTask('running', started);
    const first = adapter.run(running.task);
    await tick();

    await expect(
      adapter.run(() => Promise.resolve('late')),
    ).rejects.toBeInstanceOf(ChatBusyError);
    expect(started).toEqual(['running']);

    running.finish();
    await first;
    // The abandoned waiter must not hold or leak a slot.
    await expect(adapter.run(() => Promise.resolve('next'))).resolves.toBe(
      'next',
    );
  });

  it('frees the slot when a turn fails', async () => {
    const adapter = adapterWith({ AI_MAX_CONCURRENT_TURNS: '1' });
    await expect(
      adapter.run(() => Promise.reject(new Error('model failed'))),
    ).rejects.toThrow('model failed');
    await expect(adapter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('uses safe defaults and ignores invalid configuration', async () => {
    const started: string[] = [];
    const adapter = adapterWith({
      AI_MAX_CONCURRENT_TURNS: 'lots',
      AI_MAX_QUEUED_TURNS: '-3',
    });
    const tasks = ['a', 'b', 'c'].map((l) => manualTask(l, started));
    const results = tasks.map((t) => adapter.run(t.task));
    await tick();
    expect(started).toEqual(['a', 'b']); // default of 2
    tasks.forEach((t) => t.finish());
    await Promise.all(results);
  });
});
