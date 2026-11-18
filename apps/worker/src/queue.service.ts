import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { loadEnv } from '@clinic/shared';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

export const SYSTEM_QUEUE = 'system';

/**
 * Порожній процес: лише тримає зʼєднання з BullMQ. Черги й обробники зʼявляться на наступних етапах.
 * Redis лише тригер, тож втрата зʼєднання не валить процес (ioredis перепідключається сам).
 */
@Injectable()
export class QueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private connection?: Redis;
  private worker?: Worker;

  onModuleInit(): void {
    this.connection = new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err: Error) => this.logger.warn(`redis: ${err.message}`));
    this.worker = new Worker(SYSTEM_QUEUE, async () => undefined, { connection: this.connection });
    this.worker.on('error', (err: Error) => this.logger.warn(`bullmq: ${err.message}`));
    this.logger.log(`worker listening on queue "${SYSTEM_QUEUE}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    this.connection?.disconnect();
  }
}
