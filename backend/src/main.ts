import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // WebApp (GitHub Pages) is a different origin than this API (Railway).
  // initData in a header is the auth, so a permissive CORS origin is fine.
  app.enableCors({
    origin: true,
    allowedHeaders: ['content-type', 'x-telegram-init-data'],
    methods: ['GET', 'POST'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = app.get(ConfigService);
  const port = Number(config.get('PORT', 3000));

  await app.listen(port);
  new Logger('Bootstrap').log(`Backend listening on :${port}`);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error(`Fatal startup error: ${err.message}`, err.stack);
  process.exit(1);
});
