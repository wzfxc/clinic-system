/** Tunables from docs/analysis/04 (Q4); tests override them per instance. */
export interface WorkerConfig {
  /** Pause between sweeper passes. */
  sweepIntervalMs: number;
  /** How often a worker checks that the Redis epoch key survived. */
  epochCheckMs: number;
  /** Rows handled per database round trip. */
  batchSize: number;
  /** How long a claimed outbox row stays invisible to other copies; longer than the SMTP timeout. */
  leaseMs: number;
  smtpTimeoutMs: number;
  /** Failed deliveries before a row becomes `dead`. */
  maxAttempts: number;
  backoffBaseMs: number;
  /** Only work due within this window is mirrored into BullMQ; the sweeper covers the rest. */
  reseedHorizonMs: number;
}

export const DEFAULT_CONFIG: WorkerConfig = {
  sweepIntervalMs: 5_000,
  epochCheckMs: 10_000,
  batchSize: 100,
  leaseMs: 60_000,
  smtpTimeoutMs: 10_000,
  maxAttempts: 5,
  backoffBaseMs: 30_000,
  reseedHorizonMs: 2 * 60 * 60 * 1000,
};
