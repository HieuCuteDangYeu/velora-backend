import { LangGraphRagChatWorkflowAdapter } from './langgraph-rag-chat-workflow.adapter';
import {
  isLongRangeTurn,
  runTurnScope,
} from '@ai/domain/services/long-range-turn';

type Marker = {
  markLongRange(message: string, accessibleReelIds: string[]): void;
};

const build = (flags: Record<string, string>): Marker => {
  const marker = Object.create(
    LangGraphRagChatWorkflowAdapter.prototype,
  ) as Marker & Record<string, unknown>;
  marker.config = { get: (key: string) => flags[key] };
  marker.logger = { debug: jest.fn() };
  return marker;
};

const marked = (
  flags: Record<string, string>,
  message: string,
  reels = ['reel-1'],
) =>
  runTurnScope(() => {
    build(flags).markLongRange(message, reels);
    return Promise.resolve(isLongRangeTurn());
  });

describe('LangGraphRagChatWorkflowAdapter long-range marking', () => {
  const on = { AI_LONG_RANGE_REMOTE: 'true' };

  it('marks a summary of more than five minutes of one reel', async () => {
    await expect(
      marked(on, 'Summarize what is said from 7:17 to 14:45 in the video.'),
    ).resolves.toBe(true);
  });

  it.each([
    [
      'a range of five minutes or less',
      on,
      'Summarize what is said from 2:11 to 3:22 in the video.',
      ['reel-1'],
    ],
    [
      'a question that is not a range summary',
      on,
      'What does the speaker say at 7:17?',
      ['reel-1'],
    ],
    [
      'several shared reels',
      on,
      'Summarize what is said from 7:17 to 14:45 in the video.',
      ['reel-1', 'reel-2'],
    ],
    [
      'the flag off',
      {},
      'Summarize what is said from 7:17 to 14:45 in the video.',
      ['reel-1'],
    ],
  ] as const)('does not mark %s', async (_name, flags, message, reels) => {
    await expect(marked({ ...flags }, message, [...reels])).resolves.toBe(
      false,
    );
  });
});
