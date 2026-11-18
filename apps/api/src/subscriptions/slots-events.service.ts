/**
 * In-process pubsub fed by Postgres LISTEN/NOTIFY (trigger `appointments_notify`, migration 0008).
 * Postgres stays the source of truth: a lost notification costs the client a refetch, nothing more.
 * The payload published to subscribers carries no patient or appointment ids (docs/analysis/06 section 6).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database.module.js';

export const APPOINTMENTS_CHANNEL = 'appointments_changed';
export const SLOTS_TOPIC = 'slotsChanged';
const RECONNECT_DELAY_MS = 1000;

export interface SlotsChangedEvent {
  clinicId: number;
  doctorId: number;
  startsAt: Date;
}

/** Parses a NOTIFY payload; anything malformed is dropped (returns null). */
export function parseNotification(raw: string | undefined): SlotsChangedEvent | null {
  if (raw === undefined) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { clinicId, doctorId, startsAt } = data as Record<string, unknown>;
  if (typeof clinicId !== 'number' || typeof doctorId !== 'number' || typeof startsAt !== 'string') return null;
  const date = new Date(startsAt);
  return Number.isNaN(date.getTime()) ? null : { clinicId, doctorId, startsAt: date };
}

@Injectable()
export class SlotsEvents implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlotsEvents.name);
  private readonly pubsub = new PubSub<Record<typeof SLOTS_TOPIC, SlotsChangedEvent>>();
  private listener: PoolClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.listen();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.release();
  }

  iterator(): AsyncIterableIterator<SlotsChangedEvent> {
    return this.pubsub.asyncIterableIterator(SLOTS_TOPIC);
  }

  private async listen(): Promise<void> {
    try {
      const client = await this.pool.connect();
      this.listener = client;
      client.on('notification', (msg) => {
        if (msg.channel !== APPOINTMENTS_CHANNEL) return;
        const event = parseNotification(msg.payload);
        if (event) void this.pubsub.publish(SLOTS_TOPIC, event);
      });
      client.on('error', (err) => {
        this.logger.warn(`LISTEN connection lost: ${err.message}`);
        void this.release().then(() => this.scheduleReconnect());
      });
      await client.query(`LISTEN ${APPOINTMENTS_CHANNEL}`);
    } catch (err: unknown) {
      this.logger.warn(`LISTEN failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.release();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => void this.listen(), RECONNECT_DELAY_MS);
  }

  private async release(): Promise<void> {
    const client = this.listener;
    this.listener = undefined;
    if (!client) return;
    client.removeAllListeners('notification');
    try {
      await client.query(`UNLISTEN ${APPOINTMENTS_CHANNEL}`);
    } catch {
      // The connection is already broken; it is discarded below.
    }
    client.release(true);
  }
}
