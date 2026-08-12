import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { configuration, assertProductionConfig } from './common/config/configuration';

async function bootstrap(): Promise<void> {
  // Fail before listening rather than after, if production is misconfigured.
  assertProductionConfig(configuration());

  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);
  const log = new Logger('bootstrap');

  app.use(helmet({ contentSecurityPolicy: false }));

  /*
   * The raw body is retained for every request because the eSign callback
   * signature is computed over the exact bytes the provider sent. Re-serialising
   * the parsed JSON would change key order and whitespace and break every
   * signature check (DEC-010).
   */
  app.use(
    express.json({
      limit: '15mb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({
    origin: config.get<string>('env') === 'production' ? [config.get<string>('apiBaseUrl')!] : true,
    credentials: true,
  });

  app.enableShutdownHooks();

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);

  log.log(`GTIDS Agreement Portal API listening on ${port} (${config.get('env')})`);
  log.log(
    `eSign provider: ${config.get('esign.provider')} | ` +
      `storage: ${config.get('storage.fsRoot')} | ` +
      `renderer: ${config.get('pdf.renderer')}`,
  );
  if (process.env.RUN_SCHEDULER === 'true') log.log('scheduled jobs: ENABLED in this process');
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', e);
  process.exit(1);
});
