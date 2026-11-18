import { isCannedAssistantReply } from './canned-replies';

describe('isCannedAssistantReply', () => {
  it('recognises the assistant’s fixed replies, however they are worded after the opening', () => {
    for (const content of [
      'I can only help with Velora: its Reels and videos, what to watch next, your chats here, and using the app. Ask me about one of those and I’ll jump in.',
      'I can’t help with that request. Ask me about a Reel or another question and I’ll do my best.',
      'I could not find that in our conversation.',
      'I do not have that saved about you.',
      'Sorry, I couldn’t put together an answer just now. Please try asking again.',
    ]) {
      expect(isCannedAssistantReply({ role: 'assistant', content })).toBe(true);
    }
  });

  it('keeps real assistant answers and anything the user wrote', () => {
    expect(
      isCannedAssistantReply({
        role: 'assistant',
        content: 'Here are some reels for "pasta dinner":',
      }),
    ).toBe(false);
    expect(
      isCannedAssistantReply({
        role: 'user',
        content: 'I can only help with Velora, right?',
      }),
    ).toBe(false);
  });
});
