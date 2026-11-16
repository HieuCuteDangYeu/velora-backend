import {
  isGreetingOrThanksOnly,
  readRouterRulesEnabled,
} from './rag-greeting-shortcut';

describe('isGreetingOrThanksOnly', () => {
  it.each([
    'hi',
    'Hello!',
    'hey there 👋',
    'Good morning',
    'thanks',
    'Thank you so much!!',
    'thx velora',
    'Xin chào',
    'chào bạn',
    'Cảm ơn bạn',
    'cảm ơn',
  ])('matches %j', (message) => {
    expect(isGreetingOrThanksOnly(message)).toBe(true);
  });

  it.each([
    'thanks, but which episode shows the abandoned girl?',
    'hi, recommend a reel about pets',
    'hello what is this video about',
    'ok',
    'yes',
    'thanks for the summary, now translate it',
    '',
    'cảm ơn nhưng tập nào có cô bé?',
    'x'.repeat(80),
  ])('does not match %j', (message) => {
    expect(isGreetingOrThanksOnly(message)).toBe(false);
  });
});

describe('readRouterRulesEnabled', () => {
  const config = (value?: string) => ({
    get: () => value as never,
  });

  it('is off unless explicitly enabled', () => {
    expect(readRouterRulesEnabled(undefined)).toBe(false);
    expect(readRouterRulesEnabled(config())).toBe(false);
    expect(readRouterRulesEnabled(config('false'))).toBe(false);
    expect(readRouterRulesEnabled(config('true'))).toBe(true);
    expect(readRouterRulesEnabled(config(' TRUE '))).toBe(true);
  });
});
