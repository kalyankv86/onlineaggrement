import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Background worker (SDD §14).
 *
 * Runs the scheduled jobs in their own process. PDF rendering is memory-hungry
 * and email dispatch is latency-bound; neither should be able to starve an API
 * instance that is serving a signer mid-ceremony.
 *
 *   RUN_SCHEDULER=true npm run start:worker
 */
async function bootstrap(): Promise<void> {
  process.env.RUN_SCHEDULER = 'true';

  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const log = new Logger('worker');
  log.log('GTIDS worker started — notifications, reconciliation, SLA sweep, integrity checks');

  const shutdown = async (signal: string) => {
    log.log(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', e);
  process.exit(1);
});
