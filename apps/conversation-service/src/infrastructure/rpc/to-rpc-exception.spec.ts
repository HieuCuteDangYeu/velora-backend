import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { toRpcException } from './to-rpc-exception';

describe('toRpcException', () => {
  it.each([
    [
      'bad request',
      new BadRequestException('Message is too long'),
      400,
      'Message is too long',
    ],
    [
      'forbidden',
      new ForbiddenException('You can only recall your own messages'),
      403,
      'You can only recall your own messages',
    ],
    [
      'not found',
      new NotFoundException('Message not found'),
      404,
      'Message not found',
    ],
    [
      'conflict',
      new ConflictException('Reaction could not be saved, please retry'),
      409,
      'Reaction could not be saved, please retry',
    ],
  ])('keeps the status of a %s', (_name, error, statusCode, message) => {
    const result = toRpcException(error);

    expect(result).toBeInstanceOf(RpcException);
    expect(result.getError()).toEqual({ statusCode, message });
  });

  it('keeps a list of validation messages', () => {
    const error = new BadRequestException([
      'a is required',
      'b must be a string',
    ]);

    expect(toRpcException(error).getError()).toEqual({
      statusCode: 400,
      message: ['a is required', 'b must be a string'],
    });
  });

  it('keeps a string response and any other HTTP status', () => {
    expect(
      toRpcException(
        new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS),
      ).getError(),
    ).toEqual({ statusCode: 429, message: 'Too many requests' });
  });

  it('leaves unexpected errors as a plain message, so they stay 500s', () => {
    expect(toRpcException(new Error('connection reset')).getError()).toBe(
      'connection reset',
    );
    expect(toRpcException('boom').getError()).toBe('boom');
    expect(toRpcException(undefined).getError()).toBe('undefined');
  });
});
