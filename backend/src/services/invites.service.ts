import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SupabaseService } from '../integrations/supabase.client';
import { InviteStatus, UserRole } from '../common/enums';
import { UsersService, UserRow } from './users.service';

/**
 * Who can invite whom (PRODUCT_LOGIC §1). DIRECTOR and DEP_DIRECTOR have equal
 * rights within a store, so both can add DEP_DIRECTOR and SELLER.
 */
const CAN_INVITE: Record<UserRole, UserRole[]> = {
  [UserRole.MEGA_ADMIN]: [UserRole.REGIONAL_IT_LEAD],
  [UserRole.REGIONAL_IT_LEAD]: [UserRole.DIRECTOR],
  [UserRole.DIRECTOR]: [UserRole.DEP_DIRECTOR, UserRole.SELLER],
  [UserRole.DEP_DIRECTOR]: [UserRole.DEP_DIRECTOR, UserRole.SELLER],
  [UserRole.SELLER]: [],
};

const INVITE_TTL_DAYS = 7;

export interface CreatedInvite {
  token: string;
  role: UserRole;
  deepLink: string | null;
  expiresAt: string;
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create an invite. Scope (region/store) is derived from the creator — a
   * DIRECTOR can only invite into their own store, a REGIONAL only into their
   * own region — so a caller cannot widen their own authority.
   */
  async create(
    creator: UserRow,
    targetRole: UserRole,
    opts: { regionId?: string } = {},
  ): Promise<CreatedInvite> {
    if (!CAN_INVITE[creator.role].includes(targetRole)) {
      throw new ForbiddenException(`${creator.role} cannot invite ${targetRole}.`);
    }

    let regionId: string | null = null;
    let storeId: string | null = null;

    switch (creator.role) {
      case UserRole.MEGA_ADMIN:
        // invites REGIONAL_IT_LEAD into a region the admin specifies
        if (!opts.regionId) throw new BadRequestException('regionId is required.');
        regionId = opts.regionId;
        break;
      case UserRole.REGIONAL_IT_LEAD:
        // invites DIRECTOR into the regional's own region; store created later
        regionId = creator.region_id;
        break;
      case UserRole.DIRECTOR:
      case UserRole.DEP_DIRECTOR:
        // invites DEP_DIRECTOR / SELLER into the creator's own store
        if (!creator.store_id) throw new BadRequestException('Creator has no store scope.');
        regionId = creator.region_id;
        storeId = creator.store_id;
        break;
      default:
        throw new ForbiddenException('No invite rights.');
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();

    const { error } = await this.supabase.db.from('invites').insert({
      token,
      role: targetRole,
      region_id: regionId,
      store_id: storeId,
      created_by: creator.id,
      status: InviteStatus.active,
      expires_at: expiresAt,
    });
    if (error) throw error;

    return { token, role: targetRole, deepLink: this.deepLink(token), expiresAt };
  }

  /**
   * Consume a token: create the user with the invite's role + scope, mark the
   * invite used. Single-use is enforced by updating only while status='active'.
   */
  async consume(
    token: string,
    telegram: { id: number; name?: string },
  ): Promise<{ user: UserRow; needsStoreCreation: boolean }> {
    const existing = await this.users.findByTelegramId(telegram.id);
    if (existing) {
      // already onboarded — idempotent re-entry
      return {
        user: existing,
        needsStoreCreation: existing.role === UserRole.DIRECTOR && !existing.store_id,
      };
    }

    const { data: invite, error } = await this.supabase.db
      .from('invites')
      .select('*')
      .eq('token', token)
      .maybeSingle();
    if (error) throw error;
    if (!invite) throw new NotFoundException('Invite not found.');
    if (invite.status !== InviteStatus.active) throw new BadRequestException('Invite already used or revoked.');
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      throw new BadRequestException('Invite expired.');
    }

    const user = await this.users.create({
      telegramId: telegram.id,
      name: telegram.name,
      role: invite.role,
      regionId: invite.region_id,
      storeId: invite.store_id,
    });

    // single-use guard: only the row still 'active' is claimed
    const { data: claimed, error: claimErr } = await this.supabase.db
      .from('invites')
      .update({ status: InviteStatus.used, used_by: user.id })
      .eq('id', invite.id)
      .eq('status', InviteStatus.active)
      .select('id');
    if (claimErr) throw claimErr;
    if (!claimed?.length) throw new BadRequestException('Invite was just consumed by someone else.');

    return { user, needsStoreCreation: invite.role === UserRole.DIRECTOR };
  }

  private deepLink(token: string): string | null {
    const username = this.config.get<string>('BOT_USERNAME');
    return username ? `https://t.me/${username}?start=${token}` : null;
  }
}
