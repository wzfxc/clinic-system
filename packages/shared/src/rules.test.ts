import { describe, expect, it } from 'vitest';
import {
  BLOCK_DAYS,
  FREE_CANCEL_HOURS,
  HOLD_TTL_MINUTES,
  MAX_FUTURE_APPOINTMENTS,
  MAX_LEAD_DAYS,
  MIN_LEAD_HOURS,
  PREP_BUFFER_MINUTES,
  REMINDER_HOURS,
  SERVICE_MAX_MINUTES,
  SERVICE_MIN_MINUTES,
  SLOT_STEP_MINUTES,
  STRIKE_WINDOW_DAYS,
  STRIKES_TO_BLOCK,
  WAITLIST_OFFER_TTL_MINUTES,
} from './rules.js';

describe('business rule constants', () => {
  it('match the agreed booking and cancellation values', () => {
    expect(HOLD_TTL_MINUTES).toBe(10);
    expect(WAITLIST_OFFER_TTL_MINUTES).toBe(15);
    expect(FREE_CANCEL_HOURS).toBe(24);
    expect(MIN_LEAD_HOURS).toBe(2);
    expect(MAX_LEAD_DAYS).toBe(60);
    expect(PREP_BUFFER_MINUTES).toBe(5);
    expect(SLOT_STEP_MINUTES).toBe(15);
  });

  it('match the agreed limit and strike values', () => {
    expect(MAX_FUTURE_APPOINTMENTS).toBe(3);
    expect(STRIKE_WINDOW_DAYS).toBe(90);
    expect(STRIKES_TO_BLOCK).toBe(2);
    expect(BLOCK_DAYS).toBe(30);
  });

  it('sends reminders at 24 and 2 hours before the appointment', () => {
    expect([...REMINDER_HOURS]).toEqual([24, 2]);
  });

  it('bounds service duration to 15 to 90 minutes', () => {
    expect(SERVICE_MIN_MINUTES).toBe(15);
    expect(SERVICE_MAX_MINUTES).toBe(90);
  });
});
