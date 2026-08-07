import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateInviteDto, CreateLifehackDto, ReactDto, ResolveWorkItemDto } from './index';
import { UserRole } from '../../common/enums';

/** Mirrors the global ValidationPipe config in main.ts. */
function check<T extends object>(cls: new () => T, payload: unknown): string[] {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  return validateSync(instance as object, { whitelist: true }).flatMap((e) =>
    Object.keys(e.constraints ?? {}),
  );
}

describe('request DTOs', () => {
  describe('ResolveWorkItemDto', () => {
    it('accepts the four user-reportable outcomes', () => {
      for (const outcome of ['success', 'partial', 'fail', 'not_tried']) {
        expect(check(ResolveWorkItemDto, { outcome })).toHaveLength(0);
      }
    });

    it('rejects an arbitrary string — the gap a bare TS interface left open', () => {
      expect(check(ResolveWorkItemDto, { outcome: 'foobar' }).length).toBeGreaterThan(0);
    });

    it('rejects system-only statuses that users must not set themselves', () => {
      expect(check(ResolveWorkItemDto, { outcome: 'expired' }).length).toBeGreaterThan(0);
      expect(check(ResolveWorkItemDto, { outcome: 'in_work' }).length).toBeGreaterThan(0);
    });

    it('rejects a missing outcome', () => {
      expect(check(ResolveWorkItemDto, {}).length).toBeGreaterThan(0);
    });
  });

  describe('ReactDto', () => {
    it('accepts like and dislike', () => {
      expect(check(ReactDto, { type: 'like' })).toHaveLength(0);
      expect(check(ReactDto, { type: 'dislike' })).toHaveLength(0);
    });

    it('rejects anything else', () => {
      expect(check(ReactDto, { type: 'love' }).length).toBeGreaterThan(0);
      expect(check(ReactDto, { type: 1 }).length).toBeGreaterThan(0);
    });
  });

  describe('CreateLifehackDto', () => {
    it('accepts a minimal valid payload', () => {
      expect(check(CreateLifehackDto, { categorySlug: 'it_service', title: 'Кейс' })).toHaveLength(0);
    });

    it('rejects an empty title', () => {
      expect(
        check(CreateLifehackDto, { categorySlug: 'it_service', title: '' }).length,
      ).toBeGreaterThan(0);
    });

    it('rejects an over-long title rather than truncating silently', () => {
      expect(
        check(CreateLifehackDto, { categorySlug: 'it_service', title: 'x'.repeat(500) }).length,
      ).toBeGreaterThan(0);
    });

    it('rejects a non-string title', () => {
      expect(
        check(CreateLifehackDto, { categorySlug: 'it_service', title: { evil: true } }).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('CreateInviteDto', () => {
    it('accepts a known role', () => {
      expect(check(CreateInviteDto, { role: UserRole.SELLER })).toHaveLength(0);
    });

    it('rejects an unknown role', () => {
      expect(check(CreateInviteDto, { role: 'SUPER_ROOT' }).length).toBeGreaterThan(0);
    });

    it('rejects a non-UUID regionId', () => {
      expect(
        check(CreateInviteDto, { role: UserRole.DIRECTOR, regionId: 'not-a-uuid' }).length,
      ).toBeGreaterThan(0);
    });
  });
});
