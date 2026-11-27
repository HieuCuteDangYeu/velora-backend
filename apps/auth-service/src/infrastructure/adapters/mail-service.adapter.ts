import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { IMailService } from '../../domain/interfaces/mail-service.interface';

@Injectable()
export class MailServiceAdapter implements IMailService {
  constructor(
    @Inject('MAIL_SERVICE_CLIENT') private readonly client: ClientProxy,
    private readonly config: ConfigService,
  ) {}

  sendConfirmationEmail(email: string, token: string): void {
    const frontendUrl = this.config.get<string>('FRONTEND_URL');
    const templateId = this.config.get<string>(
      'RESEND_CONFIRM_ACCOUNT_TEMPLATE_ID',
    );

    const confirmationUrl = `${frontendUrl}/confirm?token=${token}`;

    this.client.emit('mail.send', {
      to: email,
      subject: 'Please Confirm Your Account',
      template: templateId,
      context: {
        name: email,
        url: confirmationUrl,
        otp: token,
      },
    });
  }

  sendPasswordResetEmail(email: string, token: string): void {
    const templateId = this.config.get<string>(
      'RESEND_RESET_PASSWORD_TEMPLATE_ID',
    );

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?email=${encodeURIComponent(email)}&token=${token}`;

    this.client.emit('mail.send', {
      to: email,
      subject: 'Password Reset Instructions',
      template: templateId,
      context: {
        name: email,
        url: resetLink,
        otp: token,
      },
    });
  }
}
