/** Register, login, logout and me. Sessions live in Postgres; the token travels in an HttpOnly cookie. */
import { Args, Context, Field, InputType, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ERROR_CODES } from '@clinic/shared';
import type { RequestContext } from '../graphql/context.js';
import { graphQLError, requireAuthActor } from '../graphql/guards.js';
import { MeModel } from '../graphql/models.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_COOKIE } from './sessions.js';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 200;
const MAX_PHONE_LENGTH = 32;
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const UNIQUE_VIOLATION = '23505';

@InputType('RegisterInput')
export class RegisterInput {
  @Field(() => String)
  email!: string;

  @Field(() => String)
  password!: string;

  @Field(() => String)
  fullName!: string;

  @Field(() => String, { nullable: true })
  phone?: string;
}

function validationError(field: string, message: string): Error {
  return graphQLError(ERROR_CODES.VALIDATION_FAILED, `${field}: ${message}`);
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (value.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw validationError('email', 'invalid address');
  }
  return value;
}

function validateRegistration(input: RegisterInput): { email: string; fullName: string; phone: string | null } {
  const email = normalizeEmail(input.email);
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
    throw validationError('password', `length must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH}`);
  }
  const fullName = input.fullName.trim();
  if (fullName.length === 0 || fullName.length > MAX_NAME_LENGTH) throw validationError('fullName', 'required');
  const phone = input.phone?.trim() ?? '';
  if (phone.length > MAX_PHONE_LENGTH) throw validationError('phone', 'too long');
  return { email, fullName, phone: phone.length > 0 ? phone : null };
}

/** Sets or clears the session cookie. Secure only in production, so local http works. */
function writeSessionCookie(ctx: RequestContext, token: string | null): void {
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';
  const value = token === null ? `${SESSION_COOKIE}=; Max-Age=0` : `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
  ctx.res?.setHeader('Set-Cookie', `${value}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

@Resolver(() => MeModel)
export class AuthResolver {
  @Query(() => MeModel, { description: 'The signed-in account.' })
  me(@Context() ctx: RequestContext): MeModel {
    const actor = requireAuthActor(ctx);
    return { userId: actor.userId, role: actor.role };
  }

  @Mutation(() => MeModel)
  async register(@Args('input', { type: () => RegisterInput }) input: RegisterInput, @Context() ctx: RequestContext): Promise<MeModel> {
    const data = validateRegistration(input);
    const passwordHash = await hashPassword(input.password);
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO users (email, role, password_hash, created_at)
         VALUES ($1, 'patient', $2, $3) RETURNING id::int AS id`,
        [data.email, passwordHash, ctx.clock.now()],
      );
      const userId = rows[0]?.id;
      if (userId === undefined) throw new Error('user insert returned no row');
      await client.query(`INSERT INTO patients (user_id, full_name, phone, email) VALUES ($1, $2, $3, $4)`, [
        userId,
        data.fullName,
        data.phone,
        data.email,
      ]);
      const token = await ctx.sessions.create(client, userId);
      await client.query('COMMIT');
      writeSessionCookie(ctx, token);
      return { userId, role: 'patient' };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(err)) throw graphQLError(ERROR_CODES.EMAIL_TAKEN, 'email already registered');
      throw err;
    } finally {
      client.release();
    }
  }

  @Mutation(() => MeModel)
  async login(
    @Args('email', { type: () => String }) email: string,
    @Args('password', { type: () => String }) password: string,
    @Context() ctx: RequestContext,
  ): Promise<MeModel> {
    const normalized = email.trim().toLowerCase();
    const { rows } = await ctx.pool.query<{ id: number; role: string; password_hash: string }>(
      `SELECT id::int AS id, role, password_hash FROM users WHERE email = $1`,
      [normalized],
    );
    const user = rows[0];
    const ok = user !== undefined && (await verifyPassword(password, user.password_hash));
    if (!user || !ok) throw graphQLError(ERROR_CODES.INVALID_CREDENTIALS, 'invalid email or password');
    const token = await ctx.sessions.create(ctx.pool, user.id);
    writeSessionCookie(ctx, token);
    return { userId: user.id, role: user.role };
  }

  @Mutation(() => Boolean)
  async logout(@Context() ctx: RequestContext): Promise<boolean> {
    if (ctx.sessionToken !== undefined) await ctx.sessions.revoke(ctx.sessionToken);
    writeSessionCookie(ctx, null);
    return true;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}
