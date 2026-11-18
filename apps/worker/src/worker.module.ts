import { Module } from '@nestjs/common';
import { CLOCK, SystemClock } from '@clinic/shared';
import { WorkerService } from './worker.service.js';

@Module({
  providers: [WorkerService, { provide: CLOCK, useClass: SystemClock }],
})
export class WorkerModule {}
