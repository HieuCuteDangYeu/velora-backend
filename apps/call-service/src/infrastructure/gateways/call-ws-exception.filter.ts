import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';

@Catch()
export class CallWsExceptionFilter extends BaseWsExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient<Socket>();
    const request = this.getRequestContext(host);

    if (exception instanceof HttpException) {
      this.emitException(
        client,
        host,
        this.getHttpExceptionMessage(exception),
        request,
        `http_${exception.getStatus()}`,
      );
      return;
    }

    if (exception instanceof WsException) {
      this.emitException(
        client,
        host,
        this.getWsExceptionMessage(exception),
        request,
        'ws_error',
      );
      return;
    }

    this.emitException(
      client,
      host,
      exception instanceof Error ? exception.message : 'Internal server error',
      request,
      'internal_error',
    );
  }

  private emitException(
    client: Socket,
    host: ArgumentsHost,
    message: string,
    request: { callId?: string; requestId?: string },
    code: string,
  ): void {
    client.emit('exception', {
      status: 'error',
      message,
      code,
      event: host.switchToWs().getPattern(),
      ...(request.callId ? { callId: request.callId } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}),
    });
  }

  private getRequestContext(host: ArgumentsHost): {
    callId?: string;
    requestId?: string;
  } {
    const data = host.switchToWs().getData<unknown>();
    if (!data || typeof data !== 'object') return {};
    const record = data as Record<string, unknown>;
    return {
      ...(typeof record.callId === 'string' ? { callId: record.callId } : {}),
      ...(typeof record.requestId === 'string'
        ? { requestId: record.requestId }
        : {}),
    };
  }

  private getHttpExceptionMessage(exception: HttpException): string {
    const response = exception.getResponse();

    if (typeof response === 'string' && response.length > 0) {
      return response;
    }

    if (response && typeof response === 'object' && 'message' in response) {
      const message = response['message'];

      if (typeof message === 'string' && message.length > 0) {
        return message;
      }

      if (Array.isArray(message) && typeof message[0] === 'string') {
        return message[0];
      }
    }

    return exception.message;
  }

  private getWsExceptionMessage(exception: WsException): string {
    const error = exception.getError();

    if (typeof error === 'string' && error.length > 0) {
      return error;
    }

    if (error && typeof error === 'object' && 'message' in error) {
      const message = error['message'];

      if (typeof message === 'string' && message.length > 0) {
        return message;
      }
    }

    return 'Internal server error';
  }
}
