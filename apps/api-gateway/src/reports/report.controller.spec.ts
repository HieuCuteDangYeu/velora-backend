import { ReportController } from './report.controller';

describe('ReportController', () => {
  it('e-mails the report to the moderator without the reporter needing a template', () => {
    const mailClient = { emit: jest.fn() };
    const controller = new ReportController(mailClient as never);

    const result = controller.report({ user: { id: 'reporter-1' } } as never, {
      targetType: 'message',
      targetId: 'msg-1',
      targetUserId: 'author-1',
      conversationId: 'conv-1',
      reason: 'harassment',
      details: 'Keeps insulting me',
    });

    expect(result).toEqual({ status: 'received' });
    expect(mailClient.emit).toHaveBeenCalledWith(
      'mail.send',
      expect.objectContaining({
        to: 'leanhquan1702@gmail.com',
        subject: '[Velora report] harassment · message',
      }),
    );
    const [, payload] = mailClient.emit.mock.calls[0] as [
      string,
      { text: string },
    ];
    for (const fragment of [
      'Target: message msg-1',
      'Author: author-1',
      'Conversation: conv-1',
      'Reporter: reporter-1',
      'Keeps insulting me',
    ]) {
      expect(payload.text).toContain(fragment);
    }
  });
});
