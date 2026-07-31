import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { BotService } from '../bot/bot.service';

/**
 * Global HTTP exception filter — behaves like Nest's default filter, but also
 * pings the admin's Telegram for anything that isn't an expected 4xx client
 * error (auth failures, validation, etc. stay silent; real 5xx bugs alert).
 */
@Catch()
export class TelegramAlertFilter implements ExceptionFilter {
  private readonly logger = new Logger(TelegramAlertFilter.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly bot: BotService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      const err = exception as Error;
      this.logger.error(err?.message ?? exception, err?.stack);
      const req = ctx.getRequest<{ method?: string; url?: string }>();
      void this.bot.alertAdmin(
        'http',
        `${req?.method ?? ''} ${req?.url ?? ''}\n${err?.message ?? String(exception)}`,
      );
    }

    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };

    httpAdapter.reply(ctx.getResponse(), body, status);
  }
}
