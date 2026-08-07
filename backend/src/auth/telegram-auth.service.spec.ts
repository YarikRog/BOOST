import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramAuthService } from './telegram-auth.service';

const BOT_TOKEN = '123456:TEST-TOKEN';

/** Build initData signed exactly the way Telegram signs it. */
function signInitData(fields: Record<string, string>): string {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe('TelegramAuthService', () => {
  const service = new TelegramAuthService({
    get: () => BOT_TOKEN,
  } as unknown as ConfigService);

  it('accepts correctly signed initData and returns the user', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds()),
      user: JSON.stringify({ id: 777, first_name: 'Іван' }),
    });
    expect(service.validate(initData).id).toBe(777);
  });

  it('rejects initData whose payload was tampered with after signing', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds()),
      user: JSON.stringify({ id: 777 }),
    });
    // Swap in a different user id while keeping the original signature.
    const forged = initData.replace(
      encodeURIComponent(JSON.stringify({ id: 777 })),
      encodeURIComponent(JSON.stringify({ id: 999 })),
    );
    expect(() => service.validate(forged)).toThrow(UnauthorizedException);
  });

  it('rejects a completely bogus hash', () => {
    const params = new URLSearchParams({
      auth_date: String(nowSeconds()),
      user: JSON.stringify({ id: 1 }),
      hash: 'deadbeef',
    });
    expect(() => service.validate(params.toString())).toThrow(UnauthorizedException);
  });

  it('rejects initData with no hash at all', () => {
    const params = new URLSearchParams({ user: JSON.stringify({ id: 1 }) });
    expect(() => service.validate(params.toString())).toThrow(UnauthorizedException);
  });

  it('rejects initData older than the max age', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds() - 86_400 - 60),
      user: JSON.stringify({ id: 777 }),
    });
    expect(() => service.validate(initData)).toThrow(/expired/i);
  });

  it('rejects validly signed initData that carries no user', () => {
    const initData = signInitData({ auth_date: String(nowSeconds()) });
    expect(() => service.validate(initData)).toThrow(UnauthorizedException);
  });

  it('refuses to validate anything when the bot token is unset', () => {
    const noToken = new TelegramAuthService({ get: () => undefined } as unknown as ConfigService);
    expect(() => noToken.validate('anything')).toThrow(UnauthorizedException);
  });
});
