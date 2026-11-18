import { SICK_LEAVE_TEMPLATE } from '@clinic/shared';
import { describe, expect, it } from 'vitest';
import { renderMail } from './render.js';

describe('renderMail', () => {
  it('renders every template the system writes to the outbox', () => {
    const visit = { startsAt: '2027-03-28T10:00:00Z', timezone: 'Europe/Warsaw', date: '2027-03-28' };
    for (const template of ['reminder_h24', 'reminder_h2', SICK_LEAVE_TEMPLATE]) {
      expect(renderMail(template, visit).text).toContain('2027-03-28');
    }
  });

  it('shows the visit in the clinic zone across the DST change (10:00Z is 12:00 CEST)', () => {
    expect(renderMail('reminder_h2', { startsAt: '2027-03-28T10:00:00Z', timezone: 'Europe/Warsaw' }).text).toContain('12:00');
  });

  it('refuses an unknown template and a payload without the needed fields', () => {
    expect(() => renderMail('nope', {})).toThrow(/unknown mail template/);
    expect(() => renderMail('reminder_h24', {})).toThrow(/startsAt/);
  });
});
