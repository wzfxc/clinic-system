import { Module } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { CLOCK, type Clock } from '@clinic/shared';
import { DatabaseModule, PG_POOL } from './database.module.js';
import { HealthController } from './health.controller.js';
import { HealthResolver } from './health.resolver.js';
import { AuthResolver } from './auth/auth.resolver.js';
import { AppointmentResolver } from './appointments/appointment.resolver.js';
import { BookingResolver } from './booking/booking.resolver.js';
import { buildGraphqlOptions } from './graphql/graphql.options.js';

@Module({
  imports: [
    DatabaseModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [PG_POOL, CLOCK],
      useFactory: (pool: Pool, clock: Clock) =>
        buildGraphqlOptions({ pool, clock, production: process.env['NODE_ENV'] === 'production' }),
    }),
  ],
  controllers: [HealthController],
  providers: [HealthResolver, AuthResolver, AppointmentResolver, BookingResolver],
})
export class AppModule {}
