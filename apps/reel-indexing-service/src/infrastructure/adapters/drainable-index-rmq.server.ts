import { ServerRMQ } from '@nestjs/microservices';
import type { Channel } from 'amqplib';

// Cancels job consumption only; query RPC and durable projection continue running.
export class DrainableIndexRmqServer extends ServerRMQ {
  private rawChannel?: Channel;
  private draining = false;
  private inFlight = 0;
  private readonly tag = `index-${process.pid}-${Math.random().toString(36).slice(2)}`;
  async setupChannel(channel: Channel, callback: () => void): Promise<void> {
    this.rawChannel = channel;
    if (this.draining) {
      callback();
      return;
    }
    this.options.consumerTag = this.tag;
    await super.setupChannel(channel, callback);
    if (this.draining) await channel.cancel(this.tag);
  }
  async handleMessage(
    message: Record<string, unknown>,
    channel: Channel,
  ): Promise<void> {
    this.inFlight++;
    try {
      await super.handleMessage(message, channel);
    } finally {
      this.inFlight--;
    }
  }
  async drain(timeoutMs = 120000): Promise<boolean> {
    this.draining = true;
    await this.rawChannel?.cancel(this.tag);
    const until = Date.now() + timeoutMs;
    while (this.inFlight && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    return this.inFlight === 0;
  }
}
