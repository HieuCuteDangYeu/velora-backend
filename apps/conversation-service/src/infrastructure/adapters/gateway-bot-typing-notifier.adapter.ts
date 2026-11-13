import { BOT_USER_ID } from '@common/constants/seed.constants';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { IBotTypingNotifier } from '../../domain/interfaces/bot-typing-notifier.interface';
import { ChatGateway } from '../gateways/chat.gateway';

// Clients expire a typing indicator after two missed heartbeats (see the
// mobile typingPresence policy), so a long AI turn has to keep refreshing it.
const TYPING_HEARTBEAT_MS = 3_000;
// A turn that never reports back must not leave the bot typing forever.
const TYPING_MAX_MS = 120_000;

interface ActiveTyping {
  heartbeat: NodeJS.Timeout;
  cap: NodeJS.Timeout;
}

/** Publishes the bot's typing state over the chat gateway's conversation rooms. */
@Injectable()
export class GatewayBotTypingNotifierAdapter
  implements IBotTypingNotifier, OnModuleDestroy
{
  private readonly active = new Map<string, ActiveTyping>();

  constructor(private readonly chatGateway: ChatGateway) {}

  start(conversationId: string): void {
    if (this.active.has(conversationId)) {
      return;
    }

    this.emit(conversationId, true);
    const heartbeat = setInterval(
      () => this.emit(conversationId, true),
      TYPING_HEARTBEAT_MS,
    );
    const cap = setTimeout(() => this.stop(conversationId), TYPING_MAX_MS);
    heartbeat.unref();
    cap.unref();
    this.active.set(conversationId, { heartbeat, cap });
  }

  stop(conversationId: string): void {
    const typing = this.active.get(conversationId);
    if (!typing) {
      return;
    }

    clearInterval(typing.heartbeat);
    clearTimeout(typing.cap);
    this.active.delete(conversationId);
    this.emit(conversationId, false);
  }

  onModuleDestroy(): void {
    for (const typing of this.active.values()) {
      clearInterval(typing.heartbeat);
      clearTimeout(typing.cap);
    }
    this.active.clear();
  }

  private emit(conversationId: string, isTyping: boolean): void {
    try {
      this.chatGateway.emitToConversation(conversationId, 'user_typing', {
        conversationId,
        userId: BOT_USER_ID,
        isTyping,
      });
    } catch {
      // Typing is a cosmetic signal; a socket hiccup must not fail the AI turn.
    }
  }
}
