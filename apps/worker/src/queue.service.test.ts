import { describe, expect, it } from 'vitest';
import { QueueService, SYSTEM_QUEUE } from './queue.service.js';

describe('QueueService', () => {
  it('shuts down cleanly when never initialised', async () => {
    await expect(new QueueService().onApplicationShutdown()).resolves.toBeUndefined();
    expect(SYSTEM_QUEUE).toBe('system');
  });
});
