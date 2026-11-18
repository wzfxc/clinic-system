/**
 * slotsChanged over graphql-ws against a real Nest app and Postgres: the NOTIFY trigger feeds the in-process
 * pubsub; unauthenticated connections are refused; delivery honours permissions per event.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { INestApplication } from '@nestjs/common';
import { createClient, type Client } from 'graphql-ws';
import WebSocket from 'ws';
import { FixedClock } from '@clinic/shared';
import { createTestDb, seedDoctor, seedWorld, type TestDb, type World } from '@clinic/shared/testing';
import { AuthResolver } from '../auth/auth.resolver.js';
import { SessionStore } from '../auth/sessions.js';
import { BookingResolver } from '../booking/booking.resolver.js';
import { PG_POOL } from '../database.module.js';
import { buildGraphqlOptions } from '../graphql/graphql.options.js';
import { SlotsEvents } from './slots-events.service.js';
import { SlotsResolver } from './slots.resolver.js';

const NOW = new Date('2026-06-01T08:00:00Z');
const SLOT_START = '2026-06-02T06:00:00.000Z';
const WAIT_MS = 3000;

let db: TestDb;
let app: INestApplication;
let httpUrl: string;
let wsUrl: string;
let world: World;
let doctorId: number;
let clock: FixedClock;
const clients: Client[] = [];

async function sessionCookie(userId: number): Promise<string> {
  return `session=${await new SessionStore(db.pool, clock).create(db.pool, userId)}`;
}

async function registerPatient(email: string): Promise<string> {
  const res = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `mutation { register(input: {email: "${email}", password: "correct-horse-battery", fullName: "P"}) { role } }`,
    }),
  });
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair) throw new Error('no cookie');
  return pair;
}

async function receptionist(email: string, clinicId: number): Promise<string> {
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO users (email, role, password_hash, clinic_id, created_at)
     VALUES ($1, 'receptionist', 'unused', $2, $3) RETURNING id::int AS id`,
    [email, clinicId, NOW],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user not inserted');
  return sessionCookie(id);
}

function connect(cookie: string | undefined): Client {
  class CookieSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, cookie ? { headers: { cookie } } : {});
    }
  }
  const client = createClient({ url: wsUrl, webSocketImpl: CookieSocket, retryAttempts: 0, lazy: true });
  clients.push(client);
  return client;
}

interface Collected {
  events: Record<string, unknown>[];
  error: unknown;
  opened: Promise<void>;
}

function subscribe(client: Client, clinicId: number): Collected {
  const collected: Collected = { events: [], error: undefined, opened: Promise.resolve() };
  collected.opened = new Promise<void>((resolve) => {
    client.on('connected', () => resolve());
    client.on('closed', () => resolve());
  });
  client.subscribe<Record<string, Record<string, unknown>>>(
    { query: `subscription { slotsChanged(clinicId: ${clinicId}) { clinicId doctorId startsAt } }` },
    {
      next: (value) => {
        const event = value.data?.['slotsChanged'];
        if (event) collected.events.push(event);
      },
      error: (err) => {
        collected.error = err;
      },
      complete: () => undefined,
    },
  );
  return collected;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate() && Date.now() < deadline) await sleep(25);
}

async function hold(cookie: string): Promise<void> {
  const res = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      query: `mutation { holdSlot(input: {doctorId: ${doctorId}, clinicId: ${world.clinicId}, serviceId: ${world.serviceId}, startsAt: "${SLOT_START}"}) { id } }`,
    }),
  });
  const body = (await res.json()) as { errors?: unknown };
  if (body.errors) throw new Error('hold failed');
}

beforeAll(async () => {
  db = await createTestDb();
  clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [GraphQLModule.forRoot<ApolloDriverConfig>(buildGraphqlOptions({ pool: db.pool, clock, production: false }))],
    providers: [{ provide: PG_POOL, useValue: db.pool }, AuthResolver, BookingResolver, SlotsEvents, SlotsResolver],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  httpUrl = `${base}/graphql`;
  wsUrl = `${base.replace('http', 'ws')}/graphql`;
});

afterAll(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
  await app?.close();
  await db?.close();
});

beforeEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
  await db.reset();
  world = await seedWorld(db.pool);
  doctorId = await seedDoctor(db.pool, world);
});

describe('slotsChanged subscription', () => {
  it('rejects a connection without a session at connection_init', async () => {
    const collected = subscribe(connect(undefined), world.clinicId);
    await waitFor(() => collected.error !== undefined);
    expect(collected.error).toBeDefined();
    expect(collected.events).toHaveLength(0);
  });

  it('delivers an event, without patient or appointment ids, to a permitted subscriber only', async () => {
    const patient = await registerPatient('p@example.test');
    const own = await receptionist('own@example.test', world.clinicId);
    const otherClinic = await db.pool.query<{ id: number }>(
      `INSERT INTO clinics (city, name, timezone, currency) VALUES ('C2','Other','Europe/Kyiv','UAH') RETURNING id::int AS id`,
    );
    const otherClinicId = otherClinic.rows[0]?.id;
    if (otherClinicId === undefined) throw new Error('clinic not inserted');
    const foreign = await receptionist('foreign@example.test', otherClinicId);

    const permitted = subscribe(connect(own), world.clinicId);
    const notPermitted = subscribe(connect(foreign), world.clinicId);
    await Promise.all([permitted.opened, notPermitted.opened]);
    await sleep(200);

    await hold(patient);
    await waitFor(() => permitted.events.length > 0);
    await sleep(300);

    expect(permitted.events).toHaveLength(1);
    expect(Object.keys(permitted.events[0] ?? {}).sort()).toEqual(['clinicId', 'doctorId', 'startsAt']);
    expect(permitted.events[0]?.['clinicId']).toBe(world.clinicId);
    expect(notPermitted.events).toHaveLength(0);
  });
});
