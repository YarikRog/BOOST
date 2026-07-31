import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { TelegramAuthService } from './telegram-auth.service';
import { UsersService } from '../services/users.service';

interface VerifyBody {
  initData: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: TelegramAuthService,
    private readonly users: UsersService,
  ) {}

  /**
   * POST /auth/telegram — validate initData, return the app user ("me").
   * The WebApp calls this once on launch, so it doubles as the "app opened"
   * signal for engagement stats.
   */
  @Post('telegram')
  async telegram(@Body() body: VerifyBody) {
    const tgUser = this.auth.validate(body.initData);
    const appUser = await this.users.findByTelegramId(tgUser.id);
    if (!appUser) throw new UnauthorizedException('User not onboarded.');
    const storeName = await this.users.storeName(appUser.store_id);
    await this.users.recordAppOpen(appUser.id);
    return { ...appUser, storeName };
  }
}
