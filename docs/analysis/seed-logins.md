# Demo logins (seed)

Created by the one-shot `seed` compose service (`packages/shared/src/seed`). All accounts share one password, hashed with the
same scrypt format as `apps/api/src/auth/password.ts`.

Password for every account: `demo-password`

| Role | Email | Scope |
|------|-------|-------|
| manager | `manager@clinic.local` | whole system, reports |
| receptionist | `reception1@clinic.local` (Kyiv), `reception2@clinic.local` (Lviv), `reception3@clinic.local` (Warsaw) | own clinic |
| doctor | `doctor1@clinic.local` ... `doctor40@clinic.local` | doctor `i` works in clinic `(i-1) % 3` (1 Kyiv, 2 Lviv, 3 Warsaw) |
| patient | `patient1@clinic.local` ... `patient20000@clinic.local` | own appointments |

Data: 3 clinics, 40 doctors, 15 services, 20000 patients, about 147k appointments from 180 days back to 30 days ahead
(deterministic: fixed RNG seed, clock `SEED_NOW`, default `2026-11-18T12:00:00Z`). Cancelled and no-show rows are about 49 %.
Cancelled rows carry `cancel_reason`, `updated_at` = cancel time and a `cancelled` event (`is_late` = within 24 h of the start, R1).
