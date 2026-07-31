import 'reflect-metadata';
import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { BotService } from './bot/bot.service';
import { TelegramAlertFilter } from './common/telegram-alert.filter';

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

  const httpAdapterHost = app.get(HttpAdapterHost);
  const botService = app.get(BotService);
  app.useGlobalFilters(new TelegramAlertFilter(httpAdapterHost, botService));

  // Anything that escapes Nest entirely (bad async code, a crashed worker,
  // Railway resource limits) — ping the admin before the process potentially
  // goes down, since these are exactly the outages nobody else notices.
  process.on('unhandledRejection', (reason) => {
    const err = reason as Error;
    new Logger('Process').error(`Unhandled rejection: ${err?.message ?? reason}`, err?.stack);
    void botService.alertAdmin('unhandledRejection', `${err?.message ?? reason}\n${err?.stack ?? ''}`);
  });
  process.on('uncaughtException', (err) => {
    new Logger('Process').error(`Uncaught exception: ${err.message}`, err.stack);
    void botService.alertAdmin('uncaughtException', `${err.message}\n${err.stack ?? ''}`);
  });

  const config = app.get(ConfigService);
  const port = Number(config.get('PORT', 3000));

  await app.listen(port);
  new Logger('Bootstrap').log(`Backend listening on :${port}`);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error(`Fatal startup error: ${err.message}`, err.stack);
  process.exit(1);
});
