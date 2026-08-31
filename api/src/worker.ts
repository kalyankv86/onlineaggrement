import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

/*
 * RUN_SCHEDULER must be set before app.module is *imported*, not before the
 * context is created: the @Module decorator reads it while the module file is
 * being evaluated, and a static `import` at the top of this file runs before any
 * statement here. Setting it later left ScheduleModule unregistered, so the
 * worker had no timers, nothing kept its event loop alive, and it exited 0 —
 * which systemd reports as success, so Restart=on-failure never brought it back.
 *
 * The unit also sets this, but the process must not depend on that to be correct.
 */
process.env.RUN_SCHEDULER = 'true';

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
  // Imported here, after the environment is set above.
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const log = new Logger('worker');
  log.log('GTIDS worker started — notifications, reconciliation, SLA sweep, integrity checks');

  // If the scheduler is not registered there are no timers, and the process would
  // exit silently having done nothing. Fail loudly instead.
  const { SchedulerRegistry } = await import('@nestjs/schedule');
  const jobs = app.get(SchedulerRegistry, { strict: false }).getCronJobs().size;
  if (jobs === 0) {
    log.error('No scheduled jobs registered — the worker would exit doing nothing.');
    await app.close();
    process.exit(1);
  }
  log.log(`${jobs} scheduled job(s) registered`);

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
