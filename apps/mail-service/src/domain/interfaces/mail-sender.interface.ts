export interface IMailSender {
  send(
    to: string,
    subject: string,
    template: string,
    context: Record<string, unknown>,
    text?: string,
  ): Promise<void>;
}
