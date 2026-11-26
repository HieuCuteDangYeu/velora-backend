import { SendMailDto } from '@common/mail/dtos/send-mail.dto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IMailSender } from '../../domain/interfaces/mail-sender.interface';

@Injectable()
export class SendMailUseCase {
  private readonly logger = new Logger(SendMailUseCase.name);

  constructor(
    @Inject('IMailSender') private readonly mailSender: IMailSender,
  ) {}

  async execute(dto: SendMailDto): Promise<void> {
    const { to, subject, template, context, text } = dto;

    try {
      await this.mailSender.send(to, subject, template, context, text);

      this.logger.log(`Email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send to ${to}`, error);
      throw error;
    }
  }
}
