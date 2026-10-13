import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import request from 'supertest';
import { throwError } from 'rxjs';
import { MessageController } from './message.controller';

const authenticatedUser = {
  canActivate: (context: ExecutionContext) => {
    context.switchToHttp().getRequest().user = { id: 'user-1' };
    return true;
  },
} satisfies CanActivate;

/**
 * The conversation service rejects with { statusCode, message } (see its
 * toRpcException) and Nest answers with that status by itself. A bare string
 * error, which is what the service used to send, has no status and ends as a
 * 500. This pins the contract between the two services.
 */
describe('conversation-service errors reach chat clients with their status', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MessageController],
      providers: [{ provide: 'CONVERSATION_SERVICE', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authenticatedUser)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    send.mockReset();
  });

  const react = () =>
    request(app.getHttpServer())
      .post('/messages/507f1f77bcf86cd799439011/reactions')
      .send({ emoji: '👍' });

  it.each([
    [400, 'Message has been recalled'],
    [403, 'You are not allowed to access messages in this conversation'],
    [404, 'Message not found'],
    [409, 'Reaction could not be saved, please retry'],
  ])('answers %i with the service message', async (statusCode, message) => {
    send.mockReturnValue(throwError(() => ({ statusCode, message })));

    const response = await react();

    expect(response.status).toBe(statusCode);
    expect(response.body).toMatchObject({ statusCode, message });
  });

  it('keeps a list of validation messages', async () => {
    send.mockReturnValue(
      throwError(() => ({ statusCode: 400, message: ['a is required'] })),
    );

    const response = await react();

    expect(response.status).toBe(400);
    expect(response.body.message).toEqual(['a is required']);
  });

  it('still answers 500 for an error without a status', async () => {
    send.mockReturnValue(throwError(() => 'Message has been recalled'));
    const bare = await react();
    expect(bare.status).toBe(500);
    expect(bare.body.message).toBe('Internal server error');

    send.mockReturnValue(throwError(() => new Error('socket hang up')));
    expect((await react()).status).toBe(500);
  });
});
