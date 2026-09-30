import { CallWsExceptionFilter } from '../../../src/infrastructure/gateways/call-ws-exception.filter';

describe('CallWsExceptionFilter', () => {
  it('includes request context for an in-flight media command', () => {
    const client = { emit: jest.fn() };
    const wsHost = {
      getClient: () => client,
      getData: () => ({ callId: 'call-1', requestId: 'req-1' }),
      getPattern: () => 'produce',
    };
    const host = { switchToWs: () => wsHost };

    new CallWsExceptionFilter().catch(
      new Error('Call room not found; token=private-secret'),
      host as never,
    );

    expect(client.emit).toHaveBeenCalledWith('exception', {
      status: 'error',
      message: 'Internal server error',
      code: 'internal_error',
      event: 'produce',
      callId: 'call-1',
      requestId: 'req-1',
    });
  });
});
