import { Module } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { CLOCK, SystemClock } from '@clinic/shared';
import { DatabaseModule } from './database.module.js';
import { HealthController } from './health.controller.js';
import { HealthResolver } from './health.resolver.js';

@Module({
  imports: [
    DatabaseModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true, path: '/graphql' }),
  ],
  controllers: [HealthController],
  providers: [HealthResolver, { provide: CLOCK, useClass: SystemClock }],
})
export class AppModule {}
