/**
 * Booking mutations over HTTP against a throw-away Postgres database: hold -> confirm -> cancel for the owner,
 * and NOT_FOUND for another patient's appointment (docs/analysis/06 section 3).
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { INestApplication } from '@nestjs/common';
import { FixedClock } from '@clinic/shared';
import { createTestDb, seedDoctor, seedWorld, type TestDb, type World } from '@clinic/shared/testing';
import { AuthResolver } from '../auth/auth.resolver.js';
import { buildGraphqlOptions } from '../graphql/graphql.options.js';
import { AppointmentResolver } from '../appointments/appointment.resolver.js';
import { BookingResolver } from './booking.resolver.js';

interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const NOW = new Date('2026-06-01T08:00:00Z');
const PASSWORD = 'correct-horse-battery';
const SLOT_START = '2026-06-02T06:00:00.000Z';

let db: TestDb;
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

async function register(email: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `mutation { register(input: {email: "${email}", password: "${PASSWORD}", fullName: "Test Patient"}) { role } }`,
    }),
  });
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair?.startsWith('session=')) throw new Error('register did not set a session cookie');
  return pair;
}

function holdQuery(): string {
  return `mutation { holdSlot(input: {doctorId: ${doctorId}, clinicId: ${world.clinicId}, serviceId: ${world.serviceId}, startsAt: "${SLOT_START}"}) { id status } }`;
}

beforeAll(async () => {
  db = await createTestDb();
  const clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>(buildGraphqlOptions({ pool: db.pool, clock, production: false })),
    ],
    providers: [AuthResolver, AppointmentResolver, BookingResolver],
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

describe('booking mutations', () => {
  it('hold, confirm and cancel by the owning patient move the appointment through its statuses', async () => {
    const cookie = await register('owner@example.test');

    const held = await gql(holdQuery(), cookie);
    expect(held.errors).toBeUndefined();
    const held0 = held.data?.['holdSlot'] as { id: number; status: string };
    expect(held0.status).toBe('held');

    const confirmed = await gql(
      `mutation { confirmAppointment(appointmentId: ${held0.id}, idempotencyKey: "key-1") { status } }`,
      cookie,
    );
    expect(confirmed.errors).toBeUndefined();
    expect(confirmed.data?.['confirmAppointment']).toEqual({ status: 'booked' });

    const cancelled = await gql(
      `mutation { cancelAppointment(appointmentId: ${held0.id}, reason: "changed my mind") { status } }`,
      cookie,
    );
    expect(cancelled.errors).toBeUndefined();
    expect(cancelled.data?.['cancelAppointment']).toEqual({ status: 'cancelled' });
  });

  it('another patient\'s appointment gives NOT_FOUND for confirm and cancel, like a missing id', async () => {
    const owner = await register('owner@example.test');
    const intruder = await register('intruder@example.test');
    const held = (await gql(holdQuery(), owner)).data?.['holdSlot'] as { id: number };

    const confirmForeign = await gql(
      `mutation { confirmAppointment(appointmentId: ${held.id}, idempotencyKey: "k") { id } }`,
      intruder,
    );
    expect(codeOf(confirmForeign)).toBe('HOLD_NOT_FOUND');

    const cancelForeign = await gql(
      `mutation { cancelAppointment(appointmentId: ${held.id}, reason: "nope") { id } }`,
      intruder,
    );
    const cancelMissing = await gql(
      `mutation { cancelAppointment(appointmentId: 999999, reason: "nope") { id } }`,
      intruder,
    );
    expect(codeOf(cancelForeign)).toBe('NOT_FOUND');
    expect(codeOf(cancelMissing)).toBe('NOT_FOUND');
    expect(cancelForeign.errors?.[0]?.message).toBe(cancelMissing.errors?.[0]?.message);
  });

  it('anonymous callers get UNAUTHENTICATED for patient mutations', async () => {
    const res = await gql(holdQuery());
    expect(codeOf(res)).toBe('UNAUTHENTICATED');
  });

  it('cancelling a booking offers the freed slot to the first waitlist candidate who can accept it', async () => {
    const owner = await register('owner@example.test');
    const waiter = await register('waiter@example.test');

    const held = (await gql(holdQuery(), owner)).data?.['holdSlot'] as { id: number };
    await gql(`mutation { confirmAppointment(appointmentId: ${held.id}, idempotencyKey: "k1") { status } }`, owner);

    const joined = await gql(
      `mutation { joinWaitlist(input: {doctorId: ${doctorId}, clinicId: ${world.clinicId}, serviceId: ${world.serviceId}, dateFrom: "2026-06-02", dateTo: "2026-06-02"}) }`,
      waiter,
    );
    expect(joined.errors).toBeUndefined();

    const cancelled = await gql(`mutation { cancelAppointment(appointmentId: ${held.id}, reason: "plans changed") { status } }`, owner);
    expect(cancelled.errors).toBeUndefined();

    const offersRes = await gql(`{ myWaitlistOffers { id status appointmentId } }`, waiter);
    expect(offersRes.errors).toBeUndefined();
    const offers = offersRes.data?.['myWaitlistOffers'] as { id: number; status: string; appointmentId: number }[];
    expect(offers).toHaveLength(1);
    expect(offers[0]?.status).toBe('pending');

    const accepted = await gql(
      `mutation { acceptOffer(offerId: ${offers[0]?.id}, idempotencyKey: "accept-1") { id status } }`,
      waiter,
    );
    expect(accepted.errors).toBeUndefined();
    expect(accepted.data?.['acceptOffer']).toEqual({ id: offers[0]?.appointmentId, status: 'booked' });
  });
});
