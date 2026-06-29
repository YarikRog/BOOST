import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../integrations/supabase.client';
import { Experience, UserRole, UserStatus } from '../common/enums';

export interface UserRow {
  id: string;
  telegram_id: number;
  name: string | null;
  phone: string | null;
  role: UserRole;
  region_id: string | null;
  store_id: string | null;
  status: UserStatus;
  experience_segment: Experience | null;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  async findByTelegramId(telegramId: number): Promise<UserRow | null> {
    const { data, error } = await this.supabase.db
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (error) throw error;
    return (data as UserRow) ?? null;
  }

  async create(input: {
    telegramId: number;
    name?: string | null;
    role: UserRole;
    regionId?: string | null;
    storeId?: string | null;
  }): Promise<UserRow> {
    const { data, error } = await this.supabase.db
      .from('users')
      .insert({
        telegram_id: input.telegramId,
        name: input.name ?? null,
        role: input.role,
        region_id: input.regionId ?? null,
        store_id: input.storeId ?? null,
        status: UserStatus.active,
      })
      .select('*')
      .single();
    if (error) throw error;
    return data as UserRow;
  }

  /**
   * Bootstrap the very first MEGA_ADMIN — there is no inviter for the root user.
   * Only fires if BOOTSTRAP_ADMIN_TELEGRAM_ID matches AND no MEGA_ADMIN exists yet.
   */
  async bootstrapAdminIfEligible(telegramId: number, name?: string): Promise<UserRow | null> {
    const bootstrapId = this.config.get<string>('BOOTSTRAP_ADMIN_TELEGRAM_ID');
    if (!bootstrapId || String(telegramId) !== String(bootstrapId)) return null;

    const { count, error } = await this.supabase.db
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', UserRole.MEGA_ADMIN);
    if (error) throw error;
    if ((count ?? 0) > 0) return null; // an admin already exists

    this.logger.warn(`Bootstrapping first MEGA_ADMIN for telegram_id ${telegramId}`);
    return this.create({ telegramId, name, role: UserRole.MEGA_ADMIN });
  }

  async setPhone(userId: string, phone: string): Promise<void> {
    const { error } = await this.supabase.db.from('users').update({ phone }).eq('id', userId);
    if (error) throw error;
  }

  async setExperience(userId: string, segment: Experience): Promise<void> {
    const { error } = await this.supabase.db
      .from('users')
      .update({ experience_segment: segment })
      .eq('id', userId);
    if (error) throw error;
  }

  /** MEGA_ADMIN creates a region (needed before inviting a REGIONAL_IT_LEAD). */
  async createRegion(name: string): Promise<{ id: string; name: string }> {
    const { data, error } = await this.supabase.db
      .from('regions')
      .insert({ name })
      .select('*')
      .single();
    if (error) throw error;
    return data as { id: string; name: string };
  }

  /**
   * DIRECTOR creates their store on first login (lazy creation, PRODUCT_LOGIC §1).
   * Links store ↔ director and sets the director's store_id.
   */
  async createStoreForDirector(userId: string, storeName: string): Promise<{ id: string }> {
    const user = await this.requireUser(userId);
    if (user.role !== UserRole.DIRECTOR) {
      throw new BadRequestException('Only a DIRECTOR creates a store.');
    }
    if (!user.region_id) {
      throw new BadRequestException('Director has no region scope.');
    }
    if (user.store_id) {
      throw new BadRequestException('Director already has a store.');
    }

    const { data: store, error: storeErr } = await this.supabase.db
      .from('stores')
      .insert({ name: storeName, region_id: user.region_id, director_id: userId })
      .select('id')
      .single();
    if (storeErr) throw storeErr;

    const { error: linkErr } = await this.supabase.db
      .from('users')
      .update({ store_id: (store as { id: string }).id })
      .eq('id', userId);
    if (linkErr) throw linkErr;

    return store as { id: string };
  }

  async me(userId: string): Promise<UserRow> {
    return this.requireUser(userId);
  }

  private async requireUser(userId: string): Promise<UserRow> {
    const { data, error } = await this.supabase.db
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();
    if (error) throw error;
    return data as UserRow;
  }
}
