import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ConversationMicroserviceController } from './conversation.controller';

type Handlers = {
  handleRecallMessage: (data: unknown) => Promise<unknown>;
  handleAddReaction: (data: unknown) => Promise<unknown>;
  handleCreateMessage: (data: unknown) => Promise<unknown>;
};

// Only the dependencies each handler touches before it fails are provided.
const controllerWith = (dependencies: Record<string, unknown>) => {
  const controller = Object.create(
    ConversationMicroserviceController.prototype,
  ) as Record<string, unknown>;
  controller.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  Object.assign(controller, dependencies);
  return controller as unknown as Handlers;
};

const errorOf = async (call: () => Promise<unknown>) => {
  const error = await call().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError();
};

// A bare RpcException(message) reached the gateway without a status, so these
// domain errors all surfaced as 500 "Internal server error".
describe('ConversationMicroserviceController errors keep their HTTP status', () => {
  it('recall_message: someone elses message is a 403', async () => {
    const controller = controllerWith({
      chatRepository: {
        recallMessage: jest
          .fn()
          .mockRejectedValue(
            new ForbiddenException('You can only recall your own messages'),
          ),
      },
    });

    await expect(
      errorOf(() =>
        controller.handleRecallMessage({ messageId: 'm1', userId: 'u1' }),
      ),
    ).resolves.toEqual({
      statusCode: 403,
      message: 'You can only recall your own messages',
    });
  });

  it('recall_message: the 24 hour window being over is a 400', async () => {
    const controller = controllerWith({
      chatRepository: {
        recallMessage: jest
          .fn()
          .mockRejectedValue(
            new BadRequestException(
              'Message can only be recalled within 24 hours',
            ),
          ),
      },
    });

    await expect(
      errorOf(() =>
        controller.handleRecallMessage({ messageId: 'm1', userId: 'u1' }),
      ),
    ).resolves.toEqual({
      statusCode: 400,
      message: 'Message can only be recalled within 24 hours',
    });
  });

  it('add_reaction: a missing message is a 404', async () => {
    const controller = controllerWith({
      chatRepository: {
        addReaction: jest
          .fn()
          .mockRejectedValue(new NotFoundException('Message not found')),
      },
    });

    await expect(
      errorOf(() =>
        controller.handleAddReaction({
          messageId: 'm1',
          userId: 'u1',
          emoji: '👍',
        }),
      ),
    ).resolves.toEqual({ statusCode: 404, message: 'Message not found' });
  });

  it('create_message: a rejected payload is a 400', async () => {
    const controller = controllerWith({
      sendMessageUseCase: {
        execute: jest
          .fn()
          .mockRejectedValue(new BadRequestException('Message is too long')),
      },
    });

    await expect(
      errorOf(() =>
        controller.handleCreateMessage({
          senderId: 'u1',
          conversationId: 'c1',
          content: 'x',
        }),
      ),
    ).resolves.toEqual({ statusCode: 400, message: 'Message is too long' });
  });

  it('an unexpected failure still carries only its message, so it stays a 500', async () => {
    const controller = controllerWith({
      chatRepository: {
        recallMessage: jest
          .fn()
          .mockRejectedValue(new Error('connection reset by peer')),
      },
    });

    await expect(
      errorOf(() =>
        controller.handleRecallMessage({ messageId: 'm1', userId: 'u1' }),
      ),
    ).resolves.toBe('connection reset by peer');
  });
});
