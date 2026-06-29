import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TelegramAuthService, TelegramInitUser } from './telegram-auth.service';
import { UsersService, UserRow } from '../services/users.service';

export interface AuthedRequest extends Request {
  telegramUser: TelegramInitUser;
  appUser: UserRow;
}

/**
 * Validates the `x-telegram-init-data` header, then resolves the app user.
 * Attaches both to the request. Use on WebApp endpoints that require a known user.
 */
@Injectable()
export class TelegramInitDataGuard implements CanActivate {
  constructor(
    private readonly auth: TelegramAuthService,
    private readonly users: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const initData = req.header('x-telegram-init-data');
    if (!initData) throw new UnauthorizedException('Missing x-telegram-init-data header.');

    const tgUser = this.auth.validate(initData);
    const appUser = await this.users.findByTelegramId(tgUser.id);
    if (!appUser) throw new UnauthorizedException('User not onboarded.');

    req.telegramUser = tgUser;
    req.appUser = appUser;
    return true;
  }
}
