import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import knex, { Knex } from 'knex';

export const KNEX = Symbol('KNEX');

/**
 * A single Knex instance for the process. Repositories accept an optional
 * `Knex.Transaction` so that a caller can pull any operation into an existing
 * transaction — the workflow service depends on this to keep a state change, its
 * transition record, its audit entry and its outbox row in one atomic unit.
 */
@Global()
@Module({
  providers: [
    {
      provide: KNEX,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Knex =>
        knex({
          client: 'pg',
          connection: config.get<string>('database.url'),
          pool: { min: 2, max: 10 },
          // Fail fast rather than queue forever behind an exhausted pool.
          acquireConnectionTimeout: 10_000,
        }),
    },
  ],
  exports: [KNEX],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KNEX) private readonly db: Knex) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/** Anything that can run a query: the pool, or an open transaction. */
export type Db = Knex | Knex.Transaction;
