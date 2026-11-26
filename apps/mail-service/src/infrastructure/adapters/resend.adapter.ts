import { IMailSender } from '@mail/domain/interfaces/mail-sender.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class ResendAdapter implements IMailSender {
  private readonly logger = new Logger(ResendAdapter.name);
  private readonly resend: Resend;

  constructor(private readonly config: ConfigService) {
    this.resend = new Resend(this.config.getOrThrow<string>('RESEND_API_KEY'));
  }

  async send(
    to: string,
    subject: string,
    templateId: string,
    context: Record<string, unknown>,
    text?: string,
  ): Promise<void> {
    try {
      const from = this.config.getOrThrow<string>('RESEND_FROM_EMAIL');
      const { data, error } = await this.resend.emails.send(
        text
          ? { from, to, subject, text }
          : {
              from,
              to,
              subject,
              template: {
                id: templateId,
                variables: context as Record<string, string>,
              },
            },
      );

      if (error) {
        this.logger.error('Error sending email via Resend', error);
        throw new Error(error.message);
      }

      this.logger.log(`Resend Email sent to ${to} with ID: ${data?.id}`);
    } catch (error) {
      this.logger.error('Unexpected error sending email via Resend', error);
      throw error;
    }
  }
}
