/**
 * Extension points that later blocks plug into. The domain functions call `onSlotsFreed` inside
 * the transaction that freed the time, so a consumer (the waitlist) sees the same snapshot.
 */
import type { Tx } from './tx.js';

export type FreedReason = 'cancelled' | 'rescheduled' | 'sick_leave';

/** A stretch of a doctor's (and, for ultrasound, the clinic room's) time that just became free. */
export interface FreedInterval {
  doctorId: number;
  clinicId: number;
  serviceId: number;
  usesUltrasoundRoom: boolean;
  /** `[start, end)` where `end` is `blocked_until`, the end of the preparation buffer. */
  start: Date;
  end: Date;
  reason: FreedReason;
}

export type SlotsFreedHook = (tx: Tx, intervals: readonly FreedInterval[]) => Promise<void>;

/** Empty on purpose: the waitlist (block 5) replaces it. */
export const onSlotsFreed: SlotsFreedHook = async () => {};

export interface DomainHooks {
  onSlotsFreed: SlotsFreedHook;
}

export const DEFAULT_HOOKS: DomainHooks = { onSlotsFreed };
