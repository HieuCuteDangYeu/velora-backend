import { HttpException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

// A bare RpcException(message) reaches the gateway without a status, so every
// domain error (not a member, recall window over, invalid id) surfaced as a
// 500. HttpExceptions thrown by the use cases and repositories keep their
// status here, in the { statusCode, message } shape the gateway already reads
// for the other services (see isRpcError). Anything else is unchanged.
export const toRpcException = (error: unknown): RpcException => {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message =
      typeof response === 'object' &&
      response !== null &&
      'message' in response &&
      (typeof response.message === 'string' || Array.isArray(response.message))
        ? (response.message as string | string[])
        : error.message;

    return new RpcException({ statusCode: error.getStatus(), message });
  }

  return new RpcException(
    error instanceof Error ? error.message : String(error),
  );
};
