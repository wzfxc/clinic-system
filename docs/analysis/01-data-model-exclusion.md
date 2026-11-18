# Блок 1. Модель даних та exclusion-обмеження

Джерела: `CLAUDE.md` (обмеження проєкту), `test-assignment-12.md:N` (завдання).

## Що вимагається

**Стек і обмеження проєкту**
- PostgreSQL 16 + Drizzle, розширення `btree_gist`, exclusion-обмеження для перетинів у часі (`test-assignment-12.md:13`).
- Postgres джерело правди, Redis/BullMQ лише тригери, втрата Redis нічого не ламає (`:14`, `:102`; `CLAUDE.md`).
- Інваріанти тримаються обмеженнями БД, а не лише кодом (`CLAUDE.md`; `:88`).
- Час лише через інʼєктований Clock, у тестах підміняється (`CLAUDE.md`; `:119`). Отже, у SQL не покладаємося на `now()` для бізнес-логіки.

**Предметна область**
- Клініки: Київ і Львів (`Europe/Kyiv`), Варшава (`Europe/Warsaw`) (`:61`).
- Послуга: 15–90 хв, ціна, прапорець «потрібен кабінет УЗД», один такий кабінет на клініку (`:65`).
- Лікар: спеціальність, перелік послуг, може працювати у двох клініках у різні дні (`:66`).
- Розклад: тижневий шаблон по клініках, винятки на дати, перерва, 5 хв на підготовку кабінету після кожного прийому (`:67`).
- Крок сітки 15 хв; прийом не виходить за робочий час і не зачіпає перерву (`:68`).
- Вікно запису: від +2 год до +60 днів (`:69`).
- Пацієнт: не більше 3 майбутніх записів, не більше одного на один час, до одного лікаря не частіше разу на день (`:70`).
- Безкоштовна відміна й перенос раніше ніж за 24 год, пізніше «пізня відміна» (`:71`).
- 2 неявки або пізні відміни за 90 днів закривають онлайн-запис на 30 днів (`:72`).
- Гроші цілими в копійках/грошах (`:74`).
- Статуси `held`, `booked`, `checked_in`, `completed`, `no_show`, `cancelled` (`:76`).
- Історія запису: хто і коли створив, переніс, скасував, відзначив (`:78`).
- Сід: 3 клініки, 40 лікарів, 15 послуг, 20 000 пацієнтів, 150 000 записів за 180 днів у минуле й на 30 днів уперед, розклади з винятками (`:80`).

**Інваріанти, що лягають на БД**
- Інв. 1: лікар не приймає двох одночасно; з 20 паралельних запитів бронь отримує один (`:88`, приймання №4 `:154`).
- Інв. 2: кабінет УЗД не зайнятий двічі, навіть для різних лікарів (`:89`, приймання №5 `:155`).
- Інв. 3: пацієнт не записаний на один час двічі й не перевищує ліміт 3 при паралельних запитах (`:90`).
- Інв. 4: бронь живе 10 хв; після спливу час вільний і видимий у сітці; підтвердження на секунду пізніше це відмова (`:91`, приймання №6 `:156`).
- Інв. 5: перенос атомарний; при невдачі стара запис лишається (`:92`, приймання №7 `:157`).
- Інв. 7: час, запропонований з листа очікування, не видно іншим і не пропонується двом (`:94-97`).
- Інв. 12: лікарняний скасовує всі записи дня; повтор нічого не дублює (`:107`, приймання №13 `:163`).
- Інв. 9: втрата Redis нічого не ламає, тож звільнення броней не залежить від Redis (`:102`, `:160`).

**Продуктивність:** пошук вільного часу за послугою серед усіх лікарів міста на 14 днів і звіт за 90 днів швидші за 300 мс на сіді (`:131`, приймання №17 `:167`).

**README** описує індекси, exclusion-обмеження та прийняті рішення (`:142-143`).

## Рекомендований дизайн

### Принципи

1. Усі часові точки `timestamptz`. «Стінні» часи розкладу (`time`) інтерпретуються в `clinics.timezone` (стик з блоком 2).
2. Ідентифікатори `bigint GENERATED ALWAYS AS IDENTITY`; гроші `bigint` у `*_minor`; назви `lowercase_snake_case`.
3. Що обмеженням БД:
   - перетини лікаря, УЗД-кабінету й пацієнта;
   - добова унікальність «пацієнт + лікар + день»;
   - 5-хвилинний буфер, крок сітки, межі тривалості;
   - допустимі переходи статусів;
   - append-only історія;
   - складені FK (лікар надає послугу, лікар працює в клініці, клініка надає послугу);
   - унікальність винятку розкладу;
   - непересічні шаблони розкладу лікаря.
4. Що тригером БД: ліміт 3 (потрібна серіалізація), переходи статусів, запис історії, `local_date`.
5. Що кодом (динамічні умови): вікно +2 год/+60 днів; робочий час, перерва, винятки розкладу; онлайн-блокування за неявками; ролі та права.
6. Drizzle:
   - `EXCLUDE`, часткові GiST-індекси й тригери не виражаються в `schema.ts`; усе це живе в ручних SQL-міграціях (`drizzle-kit generate --custom`). Не використовувати `drizzle-kit push`.
   - Міграція №1 робить `CREATE EXTENSION btree_gist`.
   - Інтеграційний тест звіряє `pg_constraint` і `pg_trigger` з очікуваним переліком, щоб міграція не втратила їх мовчки.
7. Час у тригерах: застосунок на початку кожної транзакції виконує `SELECT set_config('app.clock_now', $clock_iso, true)` і `set_config('app.actor_id', …, true)`. Тригери читають `current_setting('app.clock_now')` і падають, якщо він порожній. `now()` у бізнес-логіці не використовується. Єдине імʼя налаштування скрізь `app.clock_now` (`00-decisions.md`, R4).

### Таблиці та ключі

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE appointment_status AS ENUM
  ('held','booked','checked_in','completed','no_show','cancelled');
CREATE TYPE hold_kind AS ENUM ('checkout','waitlist_offer');

CREATE TABLE clinics (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city      text NOT NULL,
  name      text NOT NULL,
  timezone  text NOT NULL,                 -- 'Europe/Kyiv' | 'Europe/Warsaw'
  currency  char(3) NOT NULL CHECK (currency IN ('UAH','PLN'))
);

CREATE TABLE services (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL,
  duration_minutes int  NOT NULL CHECK (duration_minutes BETWEEN 15 AND 90
                                        AND duration_minutes % 15 = 0),
  uses_ultrasound_room boolean NOT NULL DEFAULT false
);

CREATE TABLE clinic_services (            -- ціна у валюті клініки
  clinic_id   bigint NOT NULL REFERENCES clinics(id),
  service_id  bigint NOT NULL REFERENCES services(id),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  PRIMARY KEY (clinic_id, service_id)
);
CREATE INDEX ON clinic_services (service_id);

CREATE TABLE doctors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint UNIQUE REFERENCES users(id),
  specialty text NOT NULL
);
CREATE TABLE doctor_clinics  (doctor_id bigint REFERENCES doctors(id),
  clinic_id bigint REFERENCES clinics(id),  PRIMARY KEY (doctor_id, clinic_id));
CREATE TABLE doctor_services (doctor_id bigint REFERENCES doctors(id),
  service_id bigint REFERENCES services(id), PRIMARY KEY (doctor_id, service_id));
CREATE INDEX ON doctor_clinics (clinic_id);
CREATE INDEX ON doctor_services (service_id);

CREATE TABLE patients (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint UNIQUE REFERENCES users(id),   -- NULL: заведений реєстратором
  full_name text NOT NULL, phone text, email text,
  online_booking_blocked_until timestamptz       -- кеш блокування за неявками (див. Q15)
);
```

Таблиця `users` (ролі, клініка реєстратора) належить блоку 6.

### Розклад

```sql
CREATE TABLE schedule_templates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id   bigint NOT NULL,
  clinic_id   bigint NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO
  work_start  time NOT NULL,
  work_end    time NOT NULL,
  break_start time, break_end time,
  valid_during daterange NOT NULL DEFAULT daterange(NULL, NULL, '[)'),
  FOREIGN KEY (doctor_id, clinic_id) REFERENCES doctor_clinics,
  CHECK (work_end > work_start),
  CHECK ((break_start IS NULL) = (break_end IS NULL)),
  CHECK (break_start IS NULL OR (break_start >= work_start
         AND break_end > break_start AND break_end <= work_end)),
  -- лікар не має двох шаблонів на один день тижня в один період, навіть у різних
  -- клініках («у різні дні», test-assignment-12.md:66)
  CONSTRAINT schedule_templates_no_overlap EXCLUDE USING gist
    (doctor_id WITH =, weekday WITH =, valid_during WITH &&)
);

CREATE TYPE exception_kind   AS ENUM ('day_off','extra_day');
CREATE TYPE exception_reason AS ENUM ('vacation','sick','other');
CREATE TABLE schedule_exceptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id bigint NOT NULL REFERENCES doctors(id),
  on_date   date   NOT NULL,                 -- локальна дата клініки
  kind      exception_kind NOT NULL,
  reason    exception_reason NOT NULL,
  clinic_id bigint NOT NULL,                 -- для обох видів (рішення D3, 00-decisions.md)
  work_start time, work_end time, break_start time, break_end time,
  created_by bigint, created_at timestamptz NOT NULL,
  FOREIGN KEY (doctor_id, clinic_id) REFERENCES doctor_clinics,
  -- один виняток на лікаря, клініку й дату (без kind): день або закритий, або додатковий
  CONSTRAINT schedule_exceptions_uq UNIQUE (doctor_id, clinic_id, on_date),
  CHECK ((kind = 'extra_day') = (work_start IS NOT NULL AND work_end > work_start)),
  CHECK (kind = 'extra_day' OR (work_start IS NULL AND work_end IS NULL
                                AND break_start IS NULL AND break_end IS NULL))
);
```

- `clinic_id NOT NULL` для обох видів: `day_off` (відпустка, лікарняний) завжди діє в одній клініці; лікарняний лікаря, що в цей день працює в іншій клініці, не зачіпає її. Складений FK гарантує, що лікар справді працює в цій клініці. Унікальність `(doctor_id, clinic_id, on_date)` без `kind` не дозволяє мати `day_off` і `extra_day` для тієї самої клініки й дати одночасно (`00-decisions.md`, R3). Лікарняний на дату з `extra_day` перетворює рядок на `day_off` (розділ «Лікарняний»); повтор лікарняного на вже закритий день: no-op.
- Відпустка записується по рядку на день: простіше за діапазон, дає ідемпотентний `INSERT … ON CONFLICT DO NOTHING`.
- Виняток має пріоритет над шаблоном дня.
- «Стінні» часи не залежать від DST; перетворення на `timestamptz` робить блок 2.

### Записи (центральна таблиця)

```sql
CREATE TABLE appointments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id     bigint NOT NULL,
  doctor_id     bigint NOT NULL,
  patient_id    bigint NOT NULL REFERENCES patients(id),
  service_id    bigint NOT NULL,
  status        appointment_status NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  blocked_until timestamptz NOT NULL,       -- ends_at + 5 хв (звичайний стовпець)
  local_date    date NOT NULL,              -- тригер: starts_at у зоні клініки
  uses_ultrasound_room boolean NOT NULL,    -- снапшот з послуги (для предиката)
  price_minor   bigint NOT NULL CHECK (price_minor >= 0),  -- снапшот ціни
  currency      char(3) NOT NULL,
  hold_kind       hold_kind,
  hold_expires_at timestamptz,
  waitlist_entry_id bigint,                 -- блок 5
  cancel_reason text,                       -- 'patient','sick_leave','hold_expired',...
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  time_version  int NOT NULL DEFAULT 1,     -- ++ при переносі (ключ нагадувань)

  FOREIGN KEY (doctor_id, clinic_id)  REFERENCES doctor_clinics,
  FOREIGN KEY (doctor_id, service_id) REFERENCES doctor_services,
  FOREIGN KEY (clinic_id, service_id) REFERENCES clinic_services,

  CHECK (ends_at - starts_at BETWEEN interval '15 minutes' AND interval '90 minutes'),
  CHECK (blocked_until = ends_at + interval '5 minutes'),
  CHECK (date_trunc('minute', starts_at) = starts_at
     AND extract(minute FROM starts_at AT TIME ZONE 'UTC')::int % 15 = 0),  -- сітка
  CHECK ((status = 'held') = (hold_kind IS NOT NULL AND hold_expires_at IS NOT NULL)),

  -- Інв. 1: лікар (ключ doctor_id, не clinic_id: лікар у двох клініках теж не роздвоюється)
  CONSTRAINT appt_doctor_no_overlap EXCLUDE USING gist
    (doctor_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&)
    WHERE (status <> 'cancelled'),
  -- Інв. 2: УЗД-кабінет, один на клініку
  CONSTRAINT appt_ultrasound_no_overlap EXCLUDE USING gist
    (clinic_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&)
    WHERE (uses_ultrasound_room AND status <> 'cancelled'),
  -- Інв. 3а: пацієнт не в один час (без буфера; буфер це про кабінет)
  CONSTRAINT appt_patient_no_overlap EXCLUDE USING gist
    (patient_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status <> 'cancelled')
);
-- «до одного лікаря не частіше разу на день» (:70), день за часом клініки
CREATE UNIQUE INDEX appt_patient_doctor_day_uq
  ON appointments (patient_id, doctor_id, local_date) WHERE status <> 'cancelled';
```

Рішення й уточнення:
- Предикат `status <> 'cancelled'` для всіх трьох exclusion і unique (рішення D1, `00-decisions.md`). `completed` і `no_show` продовжують займати час: вони в минулому, пацієнт не може мати двох перетинних записів і одного лікаря двічі на день. Наслідок: повторна бронь до того самого лікаря на той самий день після неявки заборонена.
- `blocked_until` у ключах і лікаря, і кабінету: один діапазон. Альтернатива «буфер лише на кабінеті УЗД»: Q1.
- Рівність `blocked_until = ends_at + 5 хв` не дає застосунку обійти буфер.
- `btree_gist` обовʼязковий, бо в GiST беруть участь `bigint`.
- Складені FK гарантують, що лікар працює в клініці й надає послугу, а клініка її надає; ціна береться з `clinic_services`.
- «Дірявий» робочий час (вихід за розклад, перерва) не обмеження БД, а код; гонку з лікарняним див. нижче.

### Held: звільнення за TTL без Redis

Прострочена `held` усе ще займає діапазон в exclusion, а годинник інʼєктований, тож «автоматично» нічого не звільниться. Рішення лише в Postgres:

1. **Reap-on-write.** Перед кожним `INSERT` броні, переносом і підтвердженням у тій самій транзакції:
   ```sql
   UPDATE appointments
      SET status='cancelled', cancel_reason='hold_expired', hold_kind=NULL, hold_expires_at=NULL
    WHERE status='held' AND hold_kind='checkout' AND hold_expires_at <= $now
      AND ( doctor_id = $doctor
            OR ($uzi AND clinic_id = $clinic AND uses_ultrasound_room)
            OR patient_id = $patient )
      AND tstzrange(starts_at, blocked_until,'[)') && tstzrange($start, $blocked,'[)');
   ```
   Використовує індекс `(doctor_id, starts_at)`. Паралельні «жнеці» серіалізуються на блокуванні рядка; другий отримує 0 оновлених.
1а. **Заміна власних checkout-холдів пацієнта** (рішення D2). При створенні нової броні `hold_kind='checkout'` у тій самій транзакції, після блокування `patients … FOR UPDATE` і до перевірки лімітів та `INSERT`, скасовуються всі власні холди цього пацієнта з `hold_kind='checkout'`, **без умови перетину діапазонів**:
   ```sql
   UPDATE appointments
      SET status='cancelled',
          cancel_reason = CASE WHEN hold_expires_at <= $now THEN 'hold_expired' ELSE 'checkout_replaced' END,
          hold_kind=NULL, hold_expires_at=NULL
    WHERE patient_id = $patient AND status='held' AND hold_kind='checkout';
   ```
   - Охоплює і активні, і прострочені холди (прострочений лише отримує причину `hold_expired`).
   - Холди `waitlist_offer` не чіпає: це пропозиції, якими керує блок 5.
   - Наслідок: пацієнт тримає не більше однієї checkout-броні; вибір іншого часу одразу звільняє попередній; прострочений холд не впливає на ліміт 3 і правило «раз на день».
   - Подія історії `hold_expired` (для прострочених) або `cancelled` з причиною `checkout_replaced` (для активних); обидва не страйк (`is_strike=false`).
   - Порядок у транзакції `hold`: `SET LOCAL app.clock_now` → `patients FOR UPDATE` → заміна власних checkout-холдів → перевірки лімітів/вікна/блоку → reap чужих прострочених у діапазоні (пункт 1) → `INSERT`.
2. **Підмітання у воркері** (блок 4): періодична задача викликає SQL-функцію `reap_expired_holds($now)` пакетами з `FOR UPDATE SKIP LOCKED`. Це оптимізація й гарантія подій; втрата Redis означає лише затримку підмітання.
3. **Читання сітки** вважає вільним лише прострочений checkout-холд: слот зайнятий, якщо `status <> 'cancelled' AND NOT (status='held' AND hold_kind='checkout' AND hold_expires_at <= $clock_now)`. Прострочений `waitlist_offer` лишається зайнятим, поки його не обробить sweeper блоку 5 (`00-decisions.md`, R2). Reap-on-write (пункт 1) теж чіпає лише `hold_kind='checkout'`.
4. **Підтвердження** (інв. 4, приймання №6):
   ```sql
   UPDATE appointments SET status='booked', hold_kind=NULL, hold_expires_at=NULL, ...
    WHERE id=$id AND patient_id=$p AND status='held' AND hold_expires_at > $now
   ```
   Нуль рядків = `HOLD_EXPIRED`. Умова строга (`>`): о `10:00:00.000` уже відмова. Після reap чужою бронею підтвердження також дає 0 рядків.
5. Звільнена бронь отримує `cancelled` з `cancel_reason='hold_expired'`; не є пізньою відміною чи неявкою. Тригер історії пише подію `hold_expired` з `is_strike=false`.

**Пропозиція листа очікування** це `held` з `hold_kind='waitlist_offer'`, `patient_id` адресата, `hold_expires_at = offer_at + 15 хв`:
- час зайнятий exclusion, не видно іншим, не пропонується двом (інв. 7) без додаткових механізмів;
- відміна запису й створення пропозиції для наступного в одній транзакції: слот ніколи не «вільний між кроками»;
- reap для `waitlist_offer` пише подію `hold_expired` в історію; воркер знаходить необроблені (`processed_at IS NULL`, Postgres-outbox) і передає пропозицію наступному; без Redis пропозиція просто чекає воркера, слот не втрачається;
- прийняття це той самий `UPDATE … SET status='booked'` з перевіркою `hold_kind='waitlist_offer'`.

### Ліміт 3 майбутніх записів при паралельних запитах

Обмеження-лічильника в PostgreSQL немає, тому `BEFORE INSERT OR UPDATE` тригер із серіалізацією по пацієнту:

```sql
CREATE FUNCTION appt_patient_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; now_ts timestamptz := current_setting('app.clock_now')::timestamptz;
BEGIN
  IF NEW.status = 'cancelled' OR NEW.starts_at <= now_ts THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' AND OLD.patient_id = NEW.patient_id THEN
    RETURN NEW;                             -- перенос / зміна статусу не збільшує лічильник
  END IF;
  PERFORM 1 FROM patients WHERE id = NEW.patient_id FOR UPDATE;   -- серіалізація
  SELECT count(*) INTO n FROM appointments
   WHERE patient_id = NEW.patient_id AND id <> COALESCE(NEW.id, -1)
     AND starts_at > now_ts
     AND (status IN ('booked','checked_in')
          OR (status = 'held' AND hold_expires_at > now_ts));
  IF n >= 3 THEN RAISE EXCEPTION 'patient_future_limit' USING ERRCODE = 'CL001'; END IF;
  RETURN NEW;
END $$;
```

- Паралельні запити одного пацієнта виконуються по черзі на блокуванні `patients`. READ COMMITTED бачить закомічену попередню вставку, тож четверта відмовляє.
- Блокування `patients` береться першим на всіх шляхах, а exclusion-перевірки після нього; цикл «пацієнт → слот» неможливий. Залишковий ризик: взаємний обмін слотами двох пацієнтів (`40P01`); код повторює спробу один раз.
- `held` входить у лічильник, поки не прострочена.
- Блокування за неявками не обмеження БД: правило з винятком для реєстратора (`:72`, приймання №14 `:164`) живе в коді; `patients.online_booking_blocked_until` лише кеш (Q15).

### Статуси: тригер переходів

| З | В | Примітка |
|---|---|---|
| held | booked, cancelled | підтвердження, TTL чи скасування |
| booked | checked_in, no_show, cancelled | плюс `completed`, див. Q5 |
| checked_in | completed, no_show, cancelled | |
| completed / no_show / cancelled | нічого | термінальні |

- Таблиця переходів у SQL: `appointment_status_transitions(from_status, to_status)` з PK та `BEFORE UPDATE OF status` тригером. Невалідний перехід це помилка `CL002`.
- Хто саме може здійснити перехід перевіряє код (блок 6). Матриця «хто з якого статусу» в README (`:76`).
- Перенос: `UPDATE appointments SET starts_at, ends_at, blocked_until, local_date, time_version = time_version + 1` в одному рядку, статус не змінюється (інв. 5). Усі три exclusion і добовий unique перевіряються атомарно; при конфлікті рядок не змінюється. Цей `UPDATE` може змінювати й `doctor_id` (Q13).

### Історія (audit)

```sql
CREATE TYPE appointment_event_kind AS ENUM
 ('created','held','confirmed','rescheduled','cancelled','checked_in',
  'completed','no_show','hold_expired','offer_accepted');
CREATE TABLE appointment_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id bigint NOT NULL REFERENCES appointments(id),
  patient_id    bigint NOT NULL,           -- денормалізація для індексів страйків
  kind          appointment_event_kind NOT NULL,
  from_status   appointment_status, to_status appointment_status,
  old_starts_at timestamptz, new_starts_at timestamptz,
  actor_user_id bigint, actor_role text,   -- з app.actor_id / app.actor_role
  is_late       boolean NOT NULL DEFAULT false,   -- відміна/перенос ≤ 24 год до початку
  is_strike     boolean NOT NULL DEFAULT false,   -- no_show або пізня відміна/перенос
  reason        text,
  occurred_at   timestamptz NOT NULL,      -- app.clock_now
  processed_at  timestamptz                -- outbox для воркера (блоки 4, 5)
);
CREATE INDEX ON appointment_events (appointment_id, occurred_at);
CREATE INDEX ON appointment_events (patient_id, occurred_at) WHERE is_strike;
CREATE INDEX ON appointment_events (id) WHERE processed_at IS NULL;
-- append-only: BEFORE UPDATE OR DELETE тригер кидає помилку (дозволене лише
-- проставлення processed_at); REVOKE UPDATE, DELETE для ролі застосунку
```

- `AFTER INSERT OR UPDATE` тригер на `appointments` сам пише подію; застосунок не може забути історію, а відповідь «хто і коли створив, переніс, скасував, відзначив» (`:78`) не залежить від коду.
- `is_late = (старий starts_at − app.clock_now) <= 24 год` (рівно 24 год це вже пізня відміна, `00-decisions.md`, R1) для відміни й переносу з `booked/checked_in`.
- Страйки (`:72`): `count(*) FROM appointment_events WHERE patient_id=$p AND is_strike AND occurred_at > $now - 90 днів`. Дві й більше дають `online_booking_blocked_until = $now + 30 днів`, у тій самій транзакції під блокуванням `patients`.

### Лікарняний (інв. 12)

Гонка: бронювання, що почалося до фіксації лікарняного, може вставити запис після того, як скасувальний `UPDATE` зробив знімок. Рішення: рядкове блокування лікаря.
- Бронювання, перенос і підтвердження у своїй транзакції виконують `SELECT 1 FROM doctors WHERE id = $d FOR SHARE`, і лише потім перевіряють винятки розкладу. Спільні блокування сумісні, тож бронювання одного лікаря не серіалізуються.
- Лікарняний в одній транзакції:
  1. `SELECT … FROM doctors WHERE id=$d FOR UPDATE` (чекає завершення всіх броней);
  2. `INSERT INTO schedule_exceptions (…, kind='day_off', reason='sick') … ON CONFLICT (doctor_id, clinic_id, on_date) DO UPDATE SET kind='day_off', reason='sick', work_start=NULL, work_end=NULL, break_start=NULL, break_end=NULL WHERE schedule_exceptions.kind = 'extra_day' RETURNING`. Рядка немає (порожній `RETURNING`) означає, що день уже закритий (`day_off`): повтор лікарняного нічого не робить;
  3. якщо рядок вставлено, скасувати всі активні записи лікаря на цю дату (`local_date`) у цій клініці: `cancelled`, `cancel_reason='sick_leave'`;
  4. записати листи й пріоритет листа очікування в outbox тієї ж транзакції.
- Повторна відмітка: `ON CONFLICT` дає порожній результат, скасовувати й слати нема чого (приймання №13).
- Альтернатива `pg_advisory_xact_lock(doctor_id, дата)`; рядкове блокування краще, бо не потребує окремого простору ключів.
- Після лікарняного скасовані слоти не показуються, бо день закритий винятком.

### Індекси під <300 мс на сіді 150 000

```sql
-- зайнятість лікаря: сітка, пошук слотів, день/тиждень лікаря (index-only)
CREATE INDEX appt_doctor_time ON appointments (doctor_id, starts_at)
  INCLUDE (blocked_until, status, hold_expires_at) WHERE status <> 'cancelled';
-- зайнятість УЗД-кабінету
CREATE INDEX appt_uzi_time ON appointments (clinic_id, starts_at)
  INCLUDE (blocked_until, status, hold_expires_at)
  WHERE uses_ultrasound_room AND status <> 'cancelled';
-- дошка дня реєстратора, всі статуси
CREATE INDEX appt_clinic_time ON appointments (clinic_id, starts_at);
-- кабінет пацієнта: майбутні й минулі візити
CREATE INDEX appt_patient_time ON appointments (patient_id, starts_at DESC);
-- підмітання броней
CREATE INDEX appt_hold_expiry ON appointments (hold_expires_at) WHERE status = 'held';
-- FK, не покриті вище
CREATE INDEX appt_service ON appointments (service_id);
-- звіт за 90 днів: index-only
CREATE INDEX appt_report ON appointments (starts_at)
  INCLUDE (doctor_id, clinic_id, service_id, status, ends_at, price_minor);
```

- Три GiST-індекси exclusion і btree-індекси подвоюють вартість запису; для 150 тис. рядків допустимо. Сід вставляє пакетами (`COPY` або багаторядковий `INSERT`) з увімкненими обмеженнями; наприкінці `VACUUM ANALYZE`, щоб index-only скани працювали.
- **Пошук слотів (14 днів, місто):** шаблони й винятки (десятки рядків) + зайнятість 40 лікарів на 14 днів (~4–6 тис. рядків) через `appt_doctor_time` і `appt_uzi_time`. Вільні інтервали рахує застосунок за блоком 2. Обовʼязково пакетне завантаження, а не запит на кожного лікаря.
- **Звіт за 90 днів** читає ~60–70 тис. рядків; одна агрегація по `appt_report` або паралельний seq scan вкладається в ~100 мс. Завантаження в %: чисельник із записів, знаменник із шаблонів і винятків (код). README описує `EXPLAIN ANALYZE`, тест перевіряє час на сіді.
- Індекси нагадувань і воркера: стик з блоком 4.

### Стики з іншими блоками

- **Блок 2:** слот вільний, якщо `[start, start+duration+5хв)` не перетинає зайнятість лікаря (і кабінету УЗД, якщо послуга вимагає). Стінні часи розкладу перетворюються на `timestamptz` у зоні клініки. Не по сітці 15 хв не пройде CHECK.
- **Блок 3:** ідемпотентність підтвердження через `idempotency_keys` (UNIQUE по ключу й актору) з посиланням на `appointment_id`. Мапінг обмежень на коди (імена обмежень → коди; фінальний реєстр у блоці 6): `appt_doctor_no_overlap` → `SLOT_TAKEN`, `appt_ultrasound_no_overlap` → `ROOM_TAKEN`, `appt_patient_no_overlap` → `PATIENT_TIME_CONFLICT`, `appt_patient_doctor_day_uq` → `DOCTOR_DAILY_LIMIT`, `CL001` → `PATIENT_LIMIT_EXCEEDED`, `CL002` → `INVALID_STATUS_TRANSITION`. SQLSTATE `23P01` exclusion, `23505` unique (інв. 15). (Агент блоку 1 пропонував інші імена кодів; тут вирівняно за блоком 6.)
- **Блок 4:** нагадування мають `UNIQUE (appointment_id, kind, time_version)` у Postgres, Redis лише тригер. Перенос збільшує `time_version`, старі нагадування не надсилаються. Скасований запис нагадувань не має.
- **Блок 5:** `waitlist_entries` (діапазон дат, лікар, `created_at` для черги); пропозиції як `held/waitlist_offer`.
- **Блок 6:** RLS у БД не плануємо; права перевіряють резолвери, підписки фільтрують за `clinic_id/patient_id/doctor_id`.

## Ризики

1. **Сід 150 000 записів фізично не вміщується при щільному пакуванні.** 40 лікарів × ~180 робочих днів (210 днів, 6 днів/тиждень) ≈ 7 200 лікаре-днів. У 8–10-годинному дні з кроком 15 хв і буфером 5 хв на практиці 10–15 активних записів на день (послуга 30 хв займає 35 хв, на сітці 45 хв), тобто ~72–108 тис. активних. Решта ~40–50 тис. мають бути `cancelled` (не беруть участі в exclusion). Генератор сіду має це робити свідомо: ~35–45% скасованих, решта без перетинів, інакше сід падає на обмеженнях. Якщо буфер лише на кабінеті (Q1), ємність зростає до ~135 тис. Зафіксувати до написання сіду. Кабінет УЗД обмежує частку УЗД-послуг до кількох відсотків.
2. **Прострочена бронь тримає слот до reap.** Reap-on-write обовʼязковий на кожному шляху запису. Тест: два клієнти підряд без воркера й без Redis.
3. **Reap чужих броней.** Обмежувати перетином із ціллю й `$now`, не чіпати чужих живих.
4. **Дедлоки при взаємному обміні слотами** (`40P01`): мало ймовірні, один повтор у коді.
5. **Тригер ліміту на `patients FOR UPDATE`** серіалізує всі записи одного пацієнта. Для звичайного користувача достатньо; масове скасування лікарняним зачіпає різних пацієнтів, конфліктів немає.
6. **Залежність тригерів від `app.clock_now` і `app.actor_id`.** Транзакція без `set_config` падає (правильно, не мовчить), тому потрібна єдина обгортка `withTx(clock, actor)` і заборона прямого доступу до пулу.
7. **Дрейф Drizzle.** `push` або перегенерація схеми прибере ручні обмеження й тригери; захист тестом на `pg_constraint`/`pg_trigger`.
8. **DST.** `blocked_until = ends_at + interval '5 minutes'` безпечна (хвилини, не доби). CHECK кроку сітки в UTC-хвилинах вірний, бо зсуви Kyiv і Warsaw цілогодинні. `local_date` з тригера бере зону клініки.
9. **Час у тестах.** `app.clock_now` передається з Clock, а не `now()` БД, інакше «підтвердження через 10:01» не відтворити.
10. **Дві клініки одного лікаря в одну добу.** Шаблони забороняють спільний день тижня, але `extra_day` може його створити. Ключ `doctor_id` в exclusion не допустить перетину в часі; час на дорогу вирішуємо кодом (Q6).
11. **Розбіжності між блоками.** Статус `no_show` вирішено в `00-decisions.md` (D1: займає слот, рахується в «раз на день»); блоки 2 і 3 вирівняно. Імʼя налаштування часу вирішено (`app.clock_now`, R4); лишаються лише розбіжності в іменах кодів помилок: звести до реєстру блоку 6.

## Відкриті питання

- **Q1. Чи діє 5-хвилинний буфер на лікаря, чи лише на кабінет УЗД?** Текст «на подготовку кабинета после каждого приёма» (`:67`) може означати лише кабінет. Пропозиція: обидва ключі (`blocked_until`), як «після кожного прийому», прописати в README. Якщо сід завузький (ризик 1), змінити ключ лікаря на `ends_at` однією міграцією.
- **Q2. Ціна: клініка чи послуга?** Валюта залежить від клініки (`:74`). Пропозиція: `clinic_services.price_minor` і знімок ціни й валюти в `appointments`. Виручку рахувати окремо по валютах без конвертації.
- **Q3. Чи пізній перенос страйк?** `:71-72` говорять про «позднюю отмену». Пропозиція: так, `rescheduled` з `is_late=true, is_strike=true`.
- **Q4. Чи рахується `held` у ліміт 3 і «один час»?** Пропозиція: так, поки не прострочена (включно з пропозиціями листа очікування).
- **Q5. Чи дозволений `booked → completed` без `checked_in`?** Лікар «відзначає завершеним» (`:46`), реєстратор «пришёл» (`:40`). Пропозиція: дозволити для лікаря, `checked_in` необовʼязковий.
- **Q6. Лікарняний: на клініку чи на всіх?** **Вирішено (D3):** на пару `(лікар, клініка, дата)`, `clinic_id NOT NULL`; узгоджено з блоком 6 Q9. Реєстратор відмічає лише лікаря, що має розклад у його клініці на цю дату. Лікар, що в цей день працює в іншій клініці, залишається доступним там (за шаблоном він у різні дні в різних клініках, `:66`).
- **Q7. Тривалість послуги кратна 15 хв?** Пропозиція: `CHECK duration % 15 = 0`, слот завжди лягає на сітку (блок 2 Q1 розглядав крок 5 хв у Zod; обрати одне).
- **Q8. Виручка: лише `completed` чи ще `no_show`/пізні відміни?** Платежів немає (`CLAUDE.md`). Пропозиція: лише `completed`, `price_minor` зі знімка.
- **Q9. `cancelled` чи видалення простроченої броні?** Пропозиція: `cancelled` з `cancel_reason='hold_expired'` (зберігає історію, не потрапляє в страйки й у відсоток скасувань).
- **Q10. Що вважати «днем» для «раз на день до лікаря»?** Пропозиція: календарний день клініки (`local_date`), а не 24 години.
- **Q11. Фіксований «сьогодні» сіду.** Сід від зафіксованого Clock (`SEED_NOW` з `.env.example`, за замовчуванням дата першого запуску), щоб «180 днів назад і 30 уперед» були відтворювані. Дату записати в README.
- **Q12. Нічні зміни через північ?** Пропозиція: ні, `CHECK work_end > work_start`, прийом у межах одного локального дня.
- **Q13. Переносити до іншого лікаря «на місці»?** Пропозиція: дозволити в одному `UPDATE` (змінюється `doctor_id`), `time_version` росте лише при зміні часу, історія пише `rescheduled` з обома значеннями.
- **Q14. RLS Postgres як додатковий захист?** Пропозиція: ні, права в резолверах і підписках (`:108-112`); повернутися, якщо ревʼю блоку 6 знайде витоки.
- **Q15. Блокування онлайн-запису: кеш-стовпець чи обчислення?** Блок 3 Q5 пропонує обчислювати з даних (частковий індекс по подіях), без `patients.online_booking_blocked_until`; цей блок пропонував кеш. Рекомендація: обчислювати з `appointment_events` (одне джерело правди), стовпець не додавати.
- **Q16. Які статуси блокують слот і займають «раз на день»?** **Вирішено (D1):** усе, крім `cancelled`, тобто `held`, `booked`, `checked_in`, `completed`, `no_show`. Предикат `status <> 'cancelled'` у DDL лишається без змін.
- **Q17. Знято** (`00-decisions.md`, R3): унікальність `(doctor_id, clinic_id, on_date)` без `kind` унеможливлює одночасні `day_off` і `extra_day`.
