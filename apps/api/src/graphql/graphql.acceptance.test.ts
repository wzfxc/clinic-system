/**
 * Acceptance 15 (direct queries) and 16 (depth limit, fixed SQL count) against a real Nest + Apollo app
 * over HTTP and a throw-away Postgres database.
 */
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { INestApplication } from '@nestjs/common';
import { FixedClock } from '@clinic/shared';
import {
  createTestDb,
  insertRawAppointment,
  seedDoctor,
  seedPatient,
  seedWorld,
  type TestDb,
  type World,
} from '@clinic/shared/testing';
import { AuthResolver } from '../auth/auth.resolver.js';
import { SessionStore } from '../auth/sessions.js';
import { AppointmentResolver } from '../appointments/appointment.resolver.js';
import { buildGraphqlOptions } from './graphql.options.js';

interface GqlError {
  message: string;
  extensions?: { code?: string };
}

interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
}

const NOW = new Date('2026-06-01T08:00:00Z');
const PASSWORD = 'correct-horse-battery';

let db: TestDb;
let clock: FixedClock;
let app: INestApplication;
let url: string;
let world: World;
let doctorId: number;

async function gql(query: string, cookie?: string): Promise<GqlResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
  return (await res.json()) as GqlResponse;
}

function codeOf(res: GqlResponse): string | undefined {
  return res.errors?.[0]?.extensions?.code;
}

/** Registers an account and returns its `session=...` cookie pair. */
async function register(email: string, fullName: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `mutation { register(input: {email: "${email}", password: "${PASSWORD}", fullName: "${fullName}"}) { role } }`,
    }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const pair = setCookie.split(';')[0];
  if (!pair?.startsWith('session=')) throw new Error('register did not set a session cookie');
  return pair;
}

async function patientId(email: string): Promise<number> {
  const { rows } = await db.pool.query<{ id: number }>(`SELECT id::int AS id FROM patients WHERE email = $1`, [email]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no patient for ${email}`);
  return id;
}

async function addAppointment(patient: number, startsAt: Date): Promise<number> {
  await db.inTx(NOW, (client) =>
    insertRawAppointment(client, { w: world, doctorId, patientId: patient, startsAt, createdAt: NOW }),
  );
  const { rows } = await db.pool.query<{ id: number }>(
    `SELECT id::int AS id FROM appointments WHERE patient_id = $1 ORDER BY id DESC LIMIT 1`,
    [patient],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('appointment not inserted');
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>(
        buildGraphqlOptions({ pool: db.pool, clock, production: false }),
      ),
    ],
    providers: [AuthResolver, AppointmentResolver],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = `${await app.getUrl()}/graphql`;
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
  world = await seedWorld(db.pool);
  doctorId = await seedDoctor(db.pool, world);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('acceptance 15: permissions on direct queries', () => {
  it('15.1 anonymous callers get UNAUTHENTICATED for protected queries', async () => {
    const res = await gql('{ myAppointments { id } }');
    expect(codeOf(res)).toBe('UNAUTHENTICATED');
  });

  it('15.2 another patient\'s appointment gives NOT_FOUND, identical to a missing id', async () => {
    const cookieP1 = await register('p1@example.test', 'Patient One');
    const cookieP2 = await register('p2@example.test', 'Patient Two');
    const p2Appointment = await addAppointment(await patientId('p2@example.test'), new Date('2026-07-01T09:00:00Z'));
    void cookieP2;

    const foreign = await gql(`{ appointment(id: ${p2Appointment}) { id } }`, cookieP1);
    const missing = await gql(`{ appointment(id: 999999) { id } }`, cookieP1);

    expect(codeOf(foreign)).toBe('NOT_FOUND');
    expect(codeOf(missing)).toBe('NOT_FOUND');
    expect(foreign.errors?.[0]?.message).toBe(missing.errors?.[0]?.message);
    expect(foreign.data?.['appointment'] ?? null).toBeNull();
  });

  it('15.3 myAppointments returns only own rows, and a foreign patient filter yields nothing', async () => {
    const cookieP1 = await register('p1@example.test', 'Patient One');
    await register('p2@example.test', 'Patient Two');
    const p1 = await patientId('p1@example.test');
    const p2 = await patientId('p2@example.test');
    const own = await addAppointment(p1, new Date('2026-07-01T09:00:00Z'));
    await addAppointment(p2, new Date('2026-07-02T09:00:00Z'));

    const mine = await gql('{ myAppointments { id } }', cookieP1);
    expect(mine.errors).toBeUndefined();
    expect(mine.data?.['myAppointments']).toEqual([{ id: own }]);

    const filtered = await gql(`{ appointments(filter: {patientId: ${p2}}) { id } }`, cookieP1);
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data?.['appointments']).toEqual([]);
  });
});

describe('acceptance 16: limits and fixed SQL count', () => {
  /** `__type(name) { ofType { ... } }` nested `levels` times; ofType is a real cycle in the schema. */
  /** Field depth is levels + 2 (`__type`, the ofType chain, `name`). */
  function nestedOfType(levels: number): string {
    return `{ __type(name: "Query") { ${'ofType { '.repeat(levels)}name${' }'.repeat(levels)} } }`;
  }

  it('16.1 a query 15 levels deep is rejected with QUERY_TOO_DEEP and runs no SQL', async () => {
    const spy = vi.spyOn(db.pool, 'query');
    const res = await gql(nestedOfType(13));
    expect(codeOf(res)).toBe('QUERY_TOO_DEEP');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a wide query over the complexity budget is rejected with QUERY_TOO_COMPLEX and runs no SQL', async () => {
    const spy = vi.spyOn(db.pool, 'query');
    const wide = `{ __type(name: "Query") { ${'fields { name } '.repeat(300)} } }`;
    expect(codeOf(await gql(wide))).toBe('QUERY_TOO_COMPLEX');
    expect(spy).not.toHaveBeenCalled();
    const narrow = `{ __type(name: "Query") { ${'fields { name } '.repeat(50)} } }`;
    expect((await gql(narrow)).errors).toBeUndefined();
  });

  it('16.2 depth 10 is accepted and depth 11 is rejected', async () => {
    const ten = await gql(nestedOfType(8));
    expect(ten.errors).toBeUndefined();
    const eleven = await gql(nestedOfType(9));
    expect(codeOf(eleven)).toBe('QUERY_TOO_DEEP');
  });

  it('16.8/16.9 SQL count for a list with relations is fixed, independent of page size and row variety', async () => {
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO users (email, role, password_hash, clinic_id, created_at)
       VALUES ('reception@example.test', 'receptionist', 'unused', $1, $2) RETURNING id::int AS id`,
      [world.clinicId, NOW],
    );
    const receptionistId = rows[0]?.id;
    if (receptionistId === undefined) throw new Error('receptionist not inserted');
    const token = await new SessionStore(db.pool, clock).create(db.pool, receptionistId);
    const cookie = `session=${token}`;
    for (let i = 0; i < 50; i += 1) {
      const pid = await seedPatient(db.pool, i);
      await addAppointment(pid, new Date(Date.UTC(2026, 6, 1, 9, 0) + i * 24 * 3_600_000));
    }
    const body = '{ appointments(first: %N) { id doctor { id } clinic { id } service { id } patient { id } } }';
    const countFor = async (first: number): Promise<number> => {
      const spy = vi.spyOn(db.pool, 'query');
      const res = await gql(body.replace('%N', String(first)), cookie);
      expect(res.errors).toBeUndefined();
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };

    const fiveRows = await countFor(5);
    const fiftyRows = await countFor(50);

    expect(fiftyRows).toBeLessThanOrEqual(6);
    expect(fiftyRows).toBe(fiveRows);
  });
});

describe('input validation', () => {
  it('rejects a page size above the maximum with VALIDATION_FAILED', async () => {
    const cookie = await register('p1@example.test', 'Patient One');
    const res = await gql('{ myAppointments(first: 1000) { id } }', cookie);
    expect(codeOf(res)).toBe('VALIDATION_FAILED');
  });

  it('never answers with a generic internal error for a malformed document', async () => {
    const res = await gql('{ nonExisting { id } }');
    expect(codeOf(res)).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(JSON.stringify(res)).not.toContain('Internal server error');
  });
});
