/**
 * Business rule constants shared by api, worker and web.
 * Times are in minutes or hours as named; no clock or locale logic lives here.
 */

/** A checkout hold blocks the slot for this long before it expires. */
export const HOLD_TTL_MINUTES = 10;

/** A waitlist offer stays open for this long before it is passed on. */
export const WAITLIST_OFFER_TTL_MINUTES = 15;

/** Cancelling or rescheduling within this many hours before the start is a late cancellation. */
export const FREE_CANCEL_HOURS = 24;

/** Minimum lead time between booking and the appointment start. */
export const MIN_LEAD_HOURS = 2;

/** Maximum distance into the future a booking may be made. */
export const MAX_LEAD_DAYS = 60;

/** Gap kept free before each appointment for preparation. */
export const PREP_BUFFER_MINUTES = 5;

/** Granularity of appointment start times on the schedule grid. */
export const SLOT_STEP_MINUTES = 15;

/** A patient may hold at most this many future appointments. */
export const MAX_FUTURE_APPOINTMENTS = 3;

/** Strikes (late cancellations and no-shows) are counted over this many days. */
export const STRIKE_WINDOW_DAYS = 90;

/** Reaching this many strikes inside the window blocks online booking. */
export const STRIKES_TO_BLOCK = 2;

/** Length of the online booking block once triggered. */
export const BLOCK_DAYS = 30;

/** Reminders are sent this many hours before the appointment, in this order. */
export const REMINDER_HOURS = [24, 2] as const;

/** Shortest service duration a service may be configured with. */
export const SERVICE_MIN_MINUTES = 15;

/** Longest service duration a service may be configured with. */
export const SERVICE_MAX_MINUTES = 90;
