import { Query, Resolver } from '@nestjs/graphql';

/** Тимчасовий корінь Query: GraphQL-схема не може бути порожньою. Видалити, коли зʼявляться реальні запити. */
@Resolver()
export class HealthResolver {
  @Query(() => String)
  health(): string {
    return 'ok';
  }
}
