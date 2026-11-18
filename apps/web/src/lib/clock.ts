/** Client-side time source; tests substitute a fixed clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
