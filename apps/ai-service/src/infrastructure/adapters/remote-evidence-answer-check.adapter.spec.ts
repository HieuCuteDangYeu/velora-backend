import { RemoteEvidenceAnswerCheckAdapter } from './remote-evidence-answer-check.adapter';

const build = (
  values: Record<string, string>,
  generateObject: jest.Mock = jest.fn(),
  withModel = true,
) =>
  new RemoteEvidenceAnswerCheckAdapter(
    { get: (key: string) => values[key] } as never,
    withModel ? ({ generateObject } as never) : undefined,
  );
const on = { AI_CLOUDFLARE_LLM_ENABLED: 'true' };

describe('RemoteEvidenceAnswerCheckAdapter', () => {
  it('offers the 0.60 band while the remote model is enabled, a configured one, and none when off', () => {
    expect(build(on).rescueMaxDistance()).toBe(0.6);
    expect(
      build({
        ...on,
        AI_EVIDENCE_RESCUE_MAX_DISTANCE: '0.58',
      }).rescueMaxDistance(),
    ).toBe(0.58);
    expect(build({}).rescueMaxDistance()).toBeUndefined();
    expect(
      build({ ...on, AI_EVIDENCE_ANSWER_CHECK: 'false' }).rescueMaxDistance(),
    ).toBeUndefined();
    expect(build(on, jest.fn(), false).rescueMaxDistance()).toBeUndefined();
  });

  it('maps the verdict and sends the question with the excerpts', async () => {
    const yes = jest.fn().mockResolvedValue({ verdict: 'ANSWERED' });
    await expect(
      build(on, yes).answersQuestion('Where was it found?', [
        'Near Lumbangan.',
      ]),
    ).resolves.toBe(true);
    expect(yes.mock.calls[0][0].userPrompt).toContain('[1] Near Lumbangan.');
    await expect(
      build(
        on,
        jest.fn().mockResolvedValue({ verdict: 'NOT_ANSWERED' }),
      ).answersQuestion('q', ['x']),
    ).resolves.toBe(false);
  });

  it('cannot tell when the call fails, answers something else, or has no excerpts', async () => {
    await expect(
      build(on, jest.fn().mockRejectedValue(new Error('429'))).answersQuestion(
        'q',
        ['x'],
      ),
    ).resolves.toBeUndefined();
    await expect(
      build(on, jest.fn().mockResolvedValue({})).answersQuestion('q', ['x']),
    ).resolves.toBeUndefined();
    const unused = jest.fn();
    await expect(
      build(on, unused).answersQuestion('q', ['  ']),
    ).resolves.toBeUndefined();
    expect(unused).not.toHaveBeenCalled();
  });
});
