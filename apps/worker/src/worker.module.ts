import { Module } from '@nestjs/common';
import { CLOCK, SystemClock } from '@clinic/shared';
import { QueueService } from './queue.service.js';

@Module({
  providers: [QueueService, { provide: CLOCK, useClass: SystemClock }],
})
export class WorkerModule {}
