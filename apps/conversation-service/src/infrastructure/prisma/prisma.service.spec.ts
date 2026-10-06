const register = jest.fn();
jest.mock('@prisma/conversation-client', () => ({
  PrismaClient: class {
    $on = register;
  },
}));

import { PrismaService } from './prisma.service';

describe('Conversation Mongo command observations', () => {
  beforeEach(() => register.mockClear());

  it('exports bounded command labels and durations without query payloads', () => {
    const metrics = { recordMongoCommand: jest.fn() };
    new PrismaService(metrics as never);
    expect(register).toHaveBeenCalledWith('query', expect.any(Function));
    const observe = register.mock.calls[0][1] as (event: unknown) => void;
    observe({
      query: 'db.messages.insertOne({ private: "content" })',
      duration: 125,
    });
    observe({
      query: 'db.messages.aggregate([{"secret": "token"}])',
      duration: 50,
    });
    observe({ query: 'db.conversations.aggregate([])', duration: 75 });
    observe({ query: 'db.conversations.updateMany({})', duration: 100 });
    observe({ query: 'db.user_key_bundles.aggregate([])', duration: 99 });
    observe({ query: 'private query', duration: 99 });
    expect(metrics.recordMongoCommand.mock.calls).toEqual([
      ['message_insert', 0.125],
      ['message_read', 0.05],
      ['conversation_read', 0.075],
      ['conversation_update', 0.1],
    ]);
    expect(JSON.stringify(metrics.recordMongoCommand.mock.calls)).not.toMatch(
      /secret|private|token|content/,
    );
  });
});
