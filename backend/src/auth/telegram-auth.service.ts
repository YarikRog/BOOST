import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface TelegramInitUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Validates Telegram WebApp initData (HMAC signature) so WebApp → backend
 * requests are trusted. Algorithm per Telegram docs:
 *   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   hash   = HMAC_SHA256(key=secret, msg=data_check_string)
 */
@Injectable()
export class TelegramAuthService {
  private static readonly MAX_AGE_SECONDS = 86400; // 24h

  constructor(private readonly config: ConfigService) {}

  validate(initData: string): TelegramInitUser {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new UnauthorizedException('Bot token not configured.');

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) throw new UnauthorizedException('initData missing hash.');
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (computed !== hash) throw new UnauthorizedException('Invalid initData signature.');

    const authDate = Number(params.get('auth_date'));
    if (authDate && Date.now() / 1000 - authDate > TelegramAuthService.MAX_AGE_SECONDS) {
      throw new UnauthorizedException('initData expired.');
    }

    const userJson = params.get('user');
    if (!userJson) throw new UnauthorizedException('initData missing user.');
    return JSON.parse(userJson) as TelegramInitUser;
  }
}
