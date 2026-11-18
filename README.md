# Clinic Network Online Booking

Monorepo (pnpm workspaces):
- `apps/api`: NestJS + GraphQL code-first (Apollo, DataLoader, `graphql-ws` subscriptions, `/health` and `/ready` REST endpoints)
- `apps/worker`: NestJS background worker (BullMQ delayed jobs, periodic Postgres sweeper, SMTP mail outbox)
- `apps/web`: Next.js 15 (App Router), React 19, `urql`, GraphQL Codegen, React Hook Form, Tailwind CSS, `next-intl` (`uk`, `en`, `pl`)
- `packages/shared`: Drizzle ORM schema and migrations, domain logic, deterministic demo seed, injected `Clock`, Zod env validation

## Run

```bash
cp .env.example .env
docker compose up --build
```

`migrate` and `seed` run automatically as one-shot Docker Compose services before `api`, `worker` and `web` start; no other manual steps are required.

Services started by `docker compose`:
- `postgres` (PostgreSQL 16 with `btree_gist`)
- `redis` (Redis 7 for BullMQ triggers)
- `mailpit` (local SMTP catcher on port `1025`, web UI on <http://localhost:8025>)
- `api` (<http://localhost:4000/graphql>, <http://localhost:4000/health>, <http://localhost:4000/ready>)
- `worker` (BullMQ consumers + periodic Postgres sweeper)
- `web` (<http://localhost:3000>, redirects to `/uk`, `/en`, `/pl`)

### Demo Logins (Seed)

The seed creates 3 clinics (`Kyiv`, `Lviv`, `Warsaw`), 40 doctors, 15 services, 20 000 patients and ~147 000 appointments from 180 days in the past to 30 days ahead. All accounts share the password `demo-password` (see [docs/analysis/seed-logins.md](docs/analysis/seed-logins.md)):

| Role | Email | Scope |
|------|-------|-------|
| Manager | `manager@clinic.local` | Network-wide 90-day report |
| Registrar | `reception1@clinic.local` (Kyiv), `reception2@clinic.local` (Lviv), `reception3@clinic.local` (Warsaw) | Own clinic (day board, check-in, no-show, phone booking, sick leave) |
| Doctor | `doctor1@clinic.local` … `doctor40@clinic.local` | Own appointments across clinics (`completed`, `no_show`) |
| Patient | `patient1@clinic.local` … `patient20000@clinic.local` | Online booking, reschedule, cancel, waitlist |

## Tests and Checks

```bash
pnpm install --frozen-lockfile
pnpm codegen                          # builds shared, emits schema, runs GraphQL codegen
pnpm typecheck                        # TypeScript check across all packages
pnpm lint                             # ESLint (no explicit any, no uncommented @ts-ignore)
pnpm db:migrate                       # applies Drizzle SQL migrations
pnpm test                             # unit + integration tests on real Postgres & Redis
pnpm build                            # builds shared, api, worker and web
pnpm --filter @clinic/web test:e2e    # Playwright e2e scenarios
```

Integration tests create an isolated temporary Postgres database per test file from `DATABASE_URL` (reading repo-root `.env` when not set in the environment). All time-dependent rules use the injected `Clock` (`FixedClock` in tests).

Playwright e2e tests (`apps/web/e2e/booking.spec.ts`) cover:
1. Selecting a slot → 10-minute hold → confirmation → the slot disappears in a second browser window live via `slotsChanged` without reload.
2. Hold not confirmed for 10 minutes → the slot returns to the free-slot grid and late confirmation at 10:01 is rejected with `HOLD_EXPIRED`.
3. Cancelling a confirmed appointment → the first waitlist candidate receives the offer and accepts it.
4. URL filter state (`city`, `serviceId`, `doctorId`, report dates) surviving reload and browser Back button, clinic timezone display (`America/New_York` browser viewing `Europe/Warsaw`), `uk`/`en`/`pl` locales (currency `₴` / `zł`, dates, plural forms), and form field validation errors.

## Free-Slot Grid Calculation

- **Schedule:** Each doctor has a weekly template per clinic (`weekday 1..7`, `work_start`, `work_end`, optional `break_start` / `break_end`, `valid_during`) and date exceptions (`day_off` or `extra_day`). An exception overrides the weekly template for that `(doctor_id, clinic_id, on_date)`.
- **Working segments:** Each active day is split into 1 or 2 working segments in UTC (`[workStart, breakStart)` and `[breakEnd, workEnd)`). A visit of `durationMinutes` must fit completely inside a single working segment without touching the break.
- **Grid step and preparation buffer:** Candidate start times step by **15 minutes** from the start of each working segment. Every visit occupies `[starts_at, ends_at + 5 minutes)` (`blocked_until = ends_at + 5 min` room preparation buffer).
- **Ultrasound room:** If a service has `uses_ultrasound_room = true`, the slot must also be free of any other ultrasound booking in that clinic during `[starts_at, blocked_until)`.
- **Booking window:** A slot must start at least **2 hours** in the future and no later than **60 calendar days** ahead in the clinic's time zone.
- **Occupancy (Decision R2):** A row occupies its interval when `status <> 'cancelled'`, **except** an expired checkout hold (`status = 'held' AND hold_kind = 'checkout' AND hold_expires_at <= clock_now`), which is immediately visible as free even before the background sweeper cancels the row. An expired `waitlist_offer` hold stays blocked until the waitlist sweeper passes it to the next candidate or frees it.
- **14-day city search and 90-day report performance:** `findFreeSlots(city, serviceId)` and `managerReport` execute in ~100–225 ms on the ~147k-row seed (asserted under 300 ms in `apps/api/src/reports/report.acceptance.test.ts`).

## Appointment Statuses

Statuses: `held`, `booked`, `checked_in`, `completed`, `no_show`, `cancelled`.

| From | To | Who | Condition |
|------|----|-----|-----------|
| *(none)* | `held` | Patient (`checkout`, 10 min) or Registrar (`front_desk`, 10 min) or System (`waitlist_offer`, 15 min) | Slot free, within 2 h–60 d window, patient limits satisfied (online also checks 30-day block) |
| `held` | `booked` | Owning patient or clinic registrar | `hold_expires_at > clock_now` (idempotent by `idempotencyKey`) |
| `held` | `cancelled` | Owning patient, clinic registrar, or system | User cancel, `hold_expired`, `checkout_replaced`, `offer_expired`, `offer_declined`, `sick_leave` |
| `booked` | `cancelled` | Owning patient or clinic registrar | Before `starts_at`; if `starts_at - now <= 24 h`, recorded as a late-cancel strike |
| `booked` | `checked_in` | Clinic registrar | On the clinic-local day of the visit |
| `booked` | `no_show` | Clinic registrar or doctor of the visit | After `starts_at`; recorded as a strike |
| `checked_in` | `no_show` | Doctor of the visit | After `starts_at`; recorded as a strike |
| `checked_in` | `completed` | Doctor of the visit | After `starts_at` |
| `held`, `booked`, `checked_in` | `cancelled` | System (registrar marks sick leave) | Future visits on that clinic day; `cancel_reason = 'sick_leave'`, never a strike |

- `checked_in` cannot be cancelled by a patient or registrar (only by a doctor's sick leave).
- **Reschedule** updates a `booked` appointment in place with optimistic concurrency (`expectedVersion` vs `time_version`; mismatch returns `CONFLICT`). Rescheduling within 24 hours of the old start is recorded as a late-reschedule strike.
- **Online booking block:** 2 or more strikes (`no_show`, late cancel, late reschedule) in the last 90 days block online booking (`channel = 'online'`) for 30 days from the last strike. A registrar (`channel = 'front_desk'`) can still book for the patient.

## Postgres vs Redis and Recovery After Redis Loss

- **Postgres is the sole source of truth.** Every future obligation is persisted in Postgres inside the same transaction as the state change:
  - Checkout hold expiry: `appointments.hold_expires_at` (`hold_kind = 'checkout'`)
  - Waitlist offer expiry: `waitlist_offers.expires_at` (`status = 'pending'`)
  - Visit reminders (24 h and 2 h): `reminders` table (`due_at`, `time_version`, `enqueued_at`, `cancelled_at`, `skipped_at`)
  - Outgoing emails: `email_outbox` table (`dedupe_key` unique, `status`, `attempts`, `next_attempt_at`, `leased_until`)
- **Redis / BullMQ is only an accelerator.** Deterministic job IDs (`reminder-<kind>-<apptId>-v<timeVersion>`, `hold-expiry-<apptId>-<epoch>`, `email-send-<outboxId>-a<attempts>`) prevent duplicate jobs.
- **Recovery after `redis-cli FLUSHALL` or Redis restart:**
  1. Each `worker` instance writes an epoch key in Redis (`clinic:worker:epoch`, `SET ... NX`) and checks it periodically. If Redis is wiped, the epoch key disappears and the worker immediately re-seeds upcoming reminders, hold expiries, and pending emails from Postgres into BullMQ.
  2. Regardless of Redis state, the periodic **sweeper** (`sweepOnce` in `apps/worker/src/sweeper.ts`) polls Postgres using `FOR UPDATE SKIP LOCKED` and leases (`leased_until`), releasing expired checkout holds, advancing overdue waitlist offers, queueing due reminders into `email_outbox`, and draining `email_outbox` to SMTP.
  3. Multiple worker copies run concurrently without duplicate execution or duplicate emails (`apps/worker/src/recovery.integration.test.ts`).

## Time Zones and DST

- All timestamps in Postgres are `timestamptz` (UTC). Each clinic stores its IANA time zone (`Europe/Kyiv`, `Europe/Warsaw`) and currency (`UAH`, `PLN`).
- Clinic-local calendar dates (`local_date`) and wall-clock times (`localTime`) are computed in the clinic's IANA zone via Luxon and enforced by a Postgres trigger (`appt_set_local_date`).
- Working segments are converted from clinic-local wall-clock time to UTC per calendar day, so visits across spring-forward and fall-back DST nights keep their exact local clinic hour while 24 h / 2 h reminders fire 24 / 2 real hours before `starts_at` (`apps/worker/src/reminders.integration.test.ts`).

## Indexes and Exclusion Constraints

Defined in `packages/shared/drizzle/0001_schema.sql` – `0009_loose_robin_chapel.sql`:
- `appt_doctor_no_overlap`: `EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&) WHERE (status <> 'cancelled')` — prevents double-booking a doctor (including the 5-minute preparation buffer).
- `appt_ultrasound_no_overlap`: `EXCLUDE USING gist (clinic_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&) WHERE (uses_ultrasound_room AND status <> 'cancelled')` — prevents two doctors in the same clinic from using the ultrasound room at overlapping times.
- `appt_patient_no_overlap`: `EXCLUDE USING gist (patient_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status <> 'cancelled')` — prevents a patient from holding two overlapping appointments.
- `appt_patient_doctor_day_uq`: `UNIQUE (patient_id, doctor_id, local_date) WHERE status <> 'cancelled'` — at most one visit per patient to the same doctor per clinic-local day.
- `schedule_templates_no_overlap`: `EXCLUDE USING gist (doctor_id WITH =, weekday WITH =, valid_during WITH &&)` — prevents overlapping template periods.
- Row triggers on `appointments`:
  - `appointments_a_local_date`: computes `local_date = (starts_at AT TIME ZONE clinic.timezone)::date`.
  - `appointments_b_patient_limit`: locks the patient row (`FOR UPDATE`) and enforces at most 3 future active appointments using `app_clock_now()`.
  - `appointments_c_status_transition`: enforces allowed `(from_status, to_status)` transitions.
  - `appointments_history` & `appointment_events_append_only`: writes append-only audit/strike events and blocks updates/deletes on `appointment_events`.
  - `appointments_z_notify`: sends `pg_notify('appointments_changed', ...)` post-commit to drive `slotsChanged` WebSocket subscriptions.
- Covering partial indexes for grid and report queries: `appt_doctor_time`, `appt_uzi_time`, `appt_report`, `appointment_events_strike_idx`, `waitlist_entries_queue_idx`, `waitlist_offers_due_idx`.

## Accepted Decisions

Full rationale is documented in [docs/analysis/00-decisions.md](docs/analysis/00-decisions.md):
- **D1:** `no_show` is treated as non-cancelled (`status <> 'cancelled'`), so it remains in history as having occupied its past slot and counts toward the once-per-day per-doctor rule.
- **D2:** Placing a new checkout hold automatically cancels any previous checkout holds of the same patient (`checkout_replaced` or `hold_expired`, never a strike).
- **D3 / R3:** Schedule exceptions always belong to a `(doctor_id, clinic_id, on_date)` triple (`UNIQUE`), with kinds `day_off` and `extra_day`.
- **D4 / R5:** Waitlist cascade scans eligible candidates in pages of 20 inside the transaction that freed the slot, using a `SAVEPOINT` per candidate so DB constraint refusals (3-future limit, overlap, once-per-day) cleanly skip to the next candidate.
- **D5:** Online-booking block is computed live from `appointment_events` (`is_strike = true` within `[now - 90 days, now]`), blocking online booking for 30 days from the latest strike. Sick leave serializes with booking via `pg_advisory_xact_lock` on the doctor, cancels the day's unstarted visits without strikes, queues one email per confirmed visit, and raises affected patients to priority 1 on the waitlist for the next 14 days.
- **R1 / R2 / R4:** Late cancel threshold is `<= 24 hours` before start; expired checkout holds are immediately free in grid reads and reaped on write; all triggers read transaction-local `app.clock_now`.
- **Known trade-offs:** Login throttling is tracked per account email in Postgres (`login_attempts`); WebSocket subscriptions implement `slotsChanged(clinicId)` (clients refetch their scoped queries on notification); waitlist offer expiry is driven by the periodic Postgres sweeper rather than a dedicated BullMQ timer.
