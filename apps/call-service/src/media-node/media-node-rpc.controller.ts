import { Controller, Inject, Logger, OnModuleInit } from '@nestjs/common';
import {
  ClientProxy,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { MediasoupCallMediaEngine } from '../infrastructure/engines/mediasoup-call.engine';
import {
  safeCallErrorCode,
  shortCallIdentifier,
} from '../infrastructure/gateways/call-debug';
import {
  isRemoteMediaMethod,
  MEDIA_NODE_INVOKE_PATTERN,
  MEDIA_NODE_STALE_INCARNATION,
  MEDIA_ROOMS_LOST_EVENT,
  type MediaNodeInvokeRequest,
  type MediaNodeRpcErrorBody,
  type MediaRoomsLostEvent,
} from './media-node.contract';
import { MediaNodeIdentity } from './media-node-identity';

/** Serves ICallMediaEngine calls for the rooms placed on this node. */
@Controller()
export class MediaNodeRpcController implements OnModuleInit {
  private readonly logger = new Logger(MediaNodeRpcController.name);

  constructor(
    private readonly engine: MediasoupCallMediaEngine,
    private readonly identity: MediaNodeIdentity,
    @Inject('CALL_SERVICE_RMQ') private readonly callClient: ClientProxy,
  ) {}

  onModuleInit(): void {
    // A dead worker takes its rooms with it. Any signaling replica can end
    // those calls; the terminal transition is idempotent.
    this.engine.onRoomsLost((callIds) => {
      const event: MediaRoomsLostEvent = {
        nodeId: this.identity.nodeId,
        incarnation: this.identity.incarnation,
        callIds,
      };
      this.callClient.emit(MEDIA_ROOMS_LOST_EVENT, event).subscribe({
        error: (error) =>
          this.logger.error(
            `Failed to report lost media rooms errorCode=${safeCallErrorCode(error)}`,
          ),
      });
    });
  }

  @MessagePattern(MEDIA_NODE_INVOKE_PATTERN)
  async invoke(@Payload() request: MediaNodeInvokeRequest): Promise<unknown> {
    if (!request || !isRemoteMediaMethod(request.method)) {
      throw this.rpcError(new Error('Unknown media method'));
    }
    if (request.incarnation !== this.identity.incarnation) {
      // The caller placed this call on a previous run of this node; its
      // rooms are gone. Never create or touch media for it here.
      throw new RpcException({
        message: 'Media node restarted',
        code: MEDIA_NODE_STALE_INCARNATION,
      } satisfies MediaNodeRpcErrorBody);
    }
    const args = Array.isArray(request.args) ? request.args : [];
    try {
      const method = this.engine[request.method] as (
        ...values: unknown[]
      ) => Promise<unknown>;
      const result: unknown = await method.apply(this.engine, args);
      // TCP replies must be JSON; `undefined` would read as "no reply".
      return result ?? null;
    } catch (error) {
      this.logger.debug(
        `Media ${request.method} failed call=${shortCallIdentifier(
          typeof args[0] === 'string' ? args[0] : undefined,
        )} errorCode=${safeCallErrorCode(error)}`,
      );
      throw this.rpcError(error);
    }
  }

  private rpcError(error: unknown): RpcException {
    return new RpcException({
      message: error instanceof Error ? error.message : 'Media request failed',
    } satisfies MediaNodeRpcErrorBody);
  }
}
