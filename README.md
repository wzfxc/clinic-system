# Clinic network online booking

Monorepo (pnpm workspaces): `apps/api` (NestJS + GraphQL), `apps/worker` (BullMQ + sweeper + mail outbox),
`apps/web` (Next.js, next-intl), `packages/shared` (Drizzle schema, migrations, domain logic, seed, Clock).

> **Honest status (deadline 17:00).** The back end is complete and tested against a real Postgres/Redis.
> The **web client is only a scaffold** and the **Playwright e2e scenarios were not written**. See
> [What is not done](#what-is-not-done) before judging the delivery.

## Run

```bash
cp .env.example .env
docker compose up --build
```

`migrate` and `seed` run as one-shot compose services; no manual steps. Services: `postgres`, `redis`, `mailpit`
(SMTP catcher, UI on <http://localhost:8025>), `api` (<http://localhost:4000>, `/health`, `/ready`, `/graphql`),
`worker`, `web` (<http://localhost:3000>).

The seed creates 3 clinics (Kyiv, Lviv, Warsaw), 40 doctors, 15 services, 20 000 patients and about 147 000
appointments from 180 days back to 30 days ahead (deterministic). Logins are in
[docs/analysis/seed-logins.md](docs/analysis/seed-logins.md): password for all accounts is `demo-password`,
e.g. `manager@clinic.local`, `reception1@clinic.local`, `doctor1@clinic.local`, `patient1@clinic.local`.

## Tests and checks

```bash
pnpm install --frozen-lockfile
pnpm codegen        # builds shared, emits schema, regenerates types; CI requires no git diff
pnpm typecheck
pnpm lint
pnpm db:migrate     # needs DATABASE_URL (Postgres)
pnpm test           # integration tests need Postgres (and Redis for the worker)
pnpm build
```

Integration tests create a throw-away database per test file from `DATABASE_URL` (repo-root `.env` is read when the
variable is not set). All time-dependent code takes an injected `Clock`; tests substitute it (10-minute hold,
15-minute step, 24 h / 2 h reminders). `pnpm --filter @clinic/web test:e2e` exists as a script, but there are no
e2e specs yet.

## Free-slot grid

- Weekly template per doctor per clinic plus date exceptions (`day_off`, `extra_day`); an exception wins over the template.
- Step is 15 minutes. A visit must fit inside working time and must not touch the break
  (working segments are `[workStart, breakStart)` and `[breakEnd, workEnd)`).
- 5 minutes of room preparation are blocked after every visit. Ultrasound services also occupy a clinic-wide room, so
  two doctors cannot do ultrasound at the same time.
- Booking window: not earlier than 2 hours and not later than 60 days from now.
- A slot is busy when `status <> 'cancelled'`, except an **expired checkout hold**, which is free (also exactly at
  expiry). An expired waitlist offer still blocks until the sweeper handles it (decision R2).
- `findFreeSlots(city, serviceId)` searches all doctors of the city for 14 days; `managerReport` covers 90 days.
  Measured on the seed: report about 100-140 ms, free slots about 140-225 ms (limit 300 ms; asserted in
  `apps/api/src/reports/report.acceptance.test.ts`).

## Appointment statuses

`held`, `booked`, `checked_in`, `completed`, `no_show`, `cancelled`.

| From | To | Who | Condition |
|------|----|-----|-----------|
| (none) | `held` | patient (checkout hold, 10 min) or system (waitlist offer) | slot free, limits ok |
| `held` | `booked` | owning patient | before `hold_expires_at`; a late confirm is rejected |
| `held` | `cancelled` | patient, system | user cancel, `hold_expired`, `checkout_replaced`, `offer_*` |
| `booked` | `cancelled` | owning patient, receptionist of the clinic | before the start; late (<= 24 h) is a strike |
| `booked` | `checked_in` | receptionist of the clinic | on the day of the visit |
| `booked` | `no_show` | receptionist or doctor | after the start; strike |
| `checked_in` | `no_show` | doctor | after the start |
| `checked_in` | `completed` | doctor of the visit | after the start |
| `held`, `booked`, `checked_in` | `cancelled` | system | sick leave, no strike |

`checked_in` cannot be cancelled by users. Reschedule is an in-place update of a `booked` visit with a `time_version`
token (stale token is `CONFLICT`). Other-patient or foreign-clinic objects answer `NOT_FOUND`/`FORBIDDEN` as in
`docs/analysis/06-permissions-graphql.md`. History is append-only (`appointment_events`) and written by triggers.

Online booking is blocked for 30 days after the last of two or more strikes (no-show, late cancel, late reschedule)
inside a 90-day window (decision D5). A patient has at most 3 future visits, and one visit per doctor per local day.

## Postgres vs Redis

Postgres is the source of truth for everything. Anything that must happen in the future (hold expiry, reminders,
waitlist offer expiry, outgoing mail) is written to Postgres **in the same transaction as the business change**
(`hold_expires_at`, `reminders`, `email_outbox`, offer rows). Redis/BullMQ only accelerates it (delayed jobs with
deterministic job ids, pub/sub for `slotsChanged`).

Recovery after losing Redis: a periodic **sweeper** in the worker polls Postgres (`FOR UPDATE SKIP LOCKED`, batches),
frees expired holds, sends due reminders and outbox mail, and re-creates queue jobs (an epoch check notices a flushed
Redis). Tests: `FLUSHALL` then worker restart, several worker copies at once, delayed job plus sweeper without
duplicate mail (`apps/worker/src/recovery.integration.test.ts`). A lost Redis costs at most one sweep interval of delay.
Waitlist offer expiry currently relies on the sweeper only.

## Time zones and DST

Instants are stored as UTC `timestamptz`; every clinic has an IANA zone and a currency. Local dates and times are
computed in the clinic zone (Luxon), `local_date` is maintained by a trigger and cannot be written by hand. Working
segments are built per local date, so a visit on a DST night keeps its local wall-clock time; 24 h reminders are
exactly 24 real hours before the start, and the mail shows local time (Warsaw DST test in
`apps/worker/src/reminders.integration.test.ts`).

## Indexes and exclusion constraints

All in `packages/shared/drizzle/*.sql`:

- `EXCLUDE USING gist` on doctor + time range for non-cancelled rows (no double booking, 20 parallel holds: one wins).
- A second exclusion on clinic room + time range for ultrasound services.
- A third exclusion on patient + time range (a patient cannot be in two places). The doctor and room exclusions
  cover the visit plus the preparation buffer (`blocked_until`).
- An exclusion on weekly templates (a doctor's template periods in the same weekday cannot overlap).
- `UNIQUE` on patient + doctor + local day for non-cancelled rows.
- Triggers: limit of 3 future visits per patient (needs `app.clock_now`, otherwise `CL003`), status transition rules,
  append-only history, `local_date`.
- `schedule_exceptions`: `UNIQUE (doctor_id, clinic_id, on_date)` with a composite FK to `doctor_clinics`.
- Supporting indexes for the outbox, reminders, sweeper scans and the report. No extra index was needed for the
  report (EXPLAIN ANALYZE on the seed).

## Accepted decisions

Full text (with reasoning) is in [docs/analysis/00-decisions.md](docs/analysis/00-decisions.md). Short list:

- D1 `no_show` occupies the slot and counts for the once-per-day rule.
- D2 A new checkout hold cancels the patient's own previous checkout holds.
- D3 Exceptions always belong to a clinic; one exception per doctor, clinic and date.
- D4/R5 Waitlist cascade: pages of 20, SAVEPOINT per candidate; DB constraints decide eligibility.
- D5 Block, permissions, sick leave: see above; sick leave serialises with booking through `pg_advisory_xact_lock`
  on the doctor.
- R1 Late cancel means start minus 24 h or less. R2 see grid. R3/R4 exception kinds and `app.clock_now` everywhere.
- Stage 9: report window is the 90 complete UTC dates before the Clock's today; revenue per currency, never summed.

## What is not done

Be aware of these before using or grading the project:

1. **Web UI is a scaffold.** Present: Next.js + next-intl (`uk`/`en`/`pl`, messages, plural forms), urql client,
   generated GraphQL types, `slotsChanged` subscription hook, money/date formatting helpers with tests, a placeholder
   home page. **Missing:** slot picker, booking/confirm flow with a 10-minute countdown, login, receptionist and doctor
   screens, waitlist offer screen, manager report page, forms with field-level errors, keyboard-only walkthrough.
2. **Playwright e2e is not written** (the three required scenarios: live slot removal in another browser, 10-minute
   hold expiry, waitlist offer accepted). The behaviours behind them are covered by API/worker integration tests, not
   by browser tests.
3. **`docker compose up` and the `compose-smoke` CI job were not run locally** by the author of this file (no Docker
   access in the working environment). Install, build and codegen were verified in a clean clone.
4. Waitlist gaps: no `slotsChanged` publish after the commit that frees a slot; offer expiry only via the sweeper (no
   delayed job); no pagination, serialization-failure (`40001`) or `FLUSHALL` tests for the waitlist; no auto-close of
   a waitlist entry on a normal booking; no limit of 5 entries per patient; join/leave exist only as GraphQL mutations.
5. Auth hardening gaps: login throttling is per account only (no per-IP counter, so lockout can be used to lock out
   someone else's account, and check-then-record is not atomic).
6. Subscriptions: only `slotsChanged` exists; `myAppointmentChanged`, `myOfferChanged`, `clinicBoardChanged` and
   `doctorDayChanged` are not implemented; the query complexity limit is not applied over WebSocket.
7. The GraphQL API has no mutation for a receptionist to create a booking on behalf of a patient (only the patient
   hold/confirm flow, cancel, reschedule, status changes, sick leave and the waitlist mutations). The description of the
   `hold` mutation in the schema says "15-minute"; the real TTL is `HOLD_TTL_MINUTES = 10` (`packages/shared/src/rules.ts`).
8. Reminders "in the app" (as opposed to by mail) have no UI.
