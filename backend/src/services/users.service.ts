import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../integrations/supabase.client';
import { Experience, SCORED_OUTCOMES, UserRole, UserStatus } from '../common/enums';

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

  /**
   * Pilot-mode: create a region + store in one shot (no invite hierarchy),
   * so a MEGA_ADMIN can spin up store #1 straight from the bot. Returns the
   * new store id; the caller builds the dir_/store_ deep links.
   */
  async createPilotStore(storeName: string): Promise<{ storeId: string }> {
    // Reject duplicates (case-insensitive) so we don't get several stores
    // sharing a name.
    const { data: dupe, error: dupeErr } = await this.supabase.db
      .from('stores')
      .select('id')
      .ilike('name', storeName)
      .maybeSingle();
    if (dupeErr) throw dupeErr;
    if (dupe) {
      throw new BadRequestException(`Магазин «${storeName}» вже існує. Обери іншу назву.`);
    }

    const { data: region, error: regionErr } = await this.supabase.db
      .from('regions')
      .insert({ name: `Pilot — ${storeName}` })
      .select('id')
      .single();
    if (regionErr) throw regionErr;

    const { data: store, error: storeErr } = await this.supabase.db
      .from('stores')
      .insert({ name: storeName, region_id: (region as { id: string }).id })
      .select('id')
      .single();
    if (storeErr) {
      // Lost the race against a concurrent create (uniq_stores_name_lower).
      if (storeErr.code === '23505') {
        await this.supabase.db.from('regions').delete().eq('id', (region as { id: string }).id);
        throw new BadRequestException(`Магазин «${storeName}» вже існує. Обери іншу назву.`);
      }
      throw storeErr;
    }

    return { storeId: (store as { id: string }).id };
  }

  /**
   * Find-or-create a region by name (case-insensitive) so entering the same
   * region for a director and later a regional lead reuses it (no duplicate).
   */
  async createRegion(name: string): Promise<{ id: string; name: string }> {
    const { data: existing } = await this.supabase.db
      .from('regions')
      .select('id, name')
      .ilike('name', name)
      .maybeSingle();
    if (existing) return existing as { id: string; name: string };

    const { data, error } = await this.supabase.db
      .from('regions')
      .insert({ name })
      .select('*')
      .single();
    if (error) throw error;
    return data as { id: string; name: string };
  }

  /**
   * DIRECTOR creates OR claims their store on first login. If a store with that
   * name already exists (e.g. a pilot store), the director is attached to it and
   * it is adopted into the director's region — no duplicate. Otherwise a new
   * store is created. (PRODUCT_LOGIC §1, lazy creation.)
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

    // Claim an existing store of the same name (case-insensitive) if free.
    const { data: existing } = await this.supabase.db
      .from('stores')
      .select('id, director_id')
      .ilike('name', storeName)
      .maybeSingle();

    let storeId: string;
    if (existing) {
      const ex = existing as { id: string; director_id: string | null };
      if (ex.director_id && ex.director_id !== userId) {
        throw new BadRequestException('Цей магазин уже має директора.');
      }
      await this.supabase.db
        .from('stores')
        .update({ region_id: user.region_id, director_id: userId })
        .eq('id', ex.id);
      storeId = ex.id;
      // Keep the store's team in the same region.
      await this.supabase.db
        .from('users')
        .update({ region_id: user.region_id })
        .eq('store_id', ex.id);
    } else {
      const { data: store, error: storeErr } = await this.supabase.db
        .from('stores')
        .insert({ name: storeName, region_id: user.region_id, director_id: userId })
        .select('id')
        .single();
      if (storeErr) {
        // Lost the race against a concurrent create (uniq_stores_name_lower).
        if (storeErr.code === '23505') {
          throw new BadRequestException(`Магазин «${storeName}» вже існує. Обери іншу назву.`);
        }
        throw storeErr;
      }
      storeId = (store as { id: string }).id;
    }

    const { error: linkErr } = await this.supabase.db
      .from('users')
      .update({ store_id: storeId })
      .eq('id', userId);
    if (linkErr) throw linkErr;

    return { id: storeId };
  }

  /**
   * Pilot-mode join: a shared, non-expiring "store_<id>" / "dir_<id>" deep
   * link (bot.service.ts) instead of a single-use invite. Only for store #1
   * running without the referral hierarchy — see PRODUCT_LOGIC.md pilot note.
   * Idempotent: re-entry by an already-known telegram_id returns the existing row.
   */
  async joinStoreDirect(
    telegramId: number,
    storeId: string,
    role: UserRole.SELLER | UserRole.DIRECTOR,
    name?: string,
  ): Promise<UserRow> {
    const existing = await this.findByTelegramId(telegramId);
    if (existing) return existing;

    const { data: store, error: storeErr } = await this.supabase.db
      .from('stores')
      .select('id, region_id')
      .eq('id', storeId)
      .maybeSingle();
    if (storeErr) throw storeErr;
    if (!store) throw new BadRequestException('Store link is invalid.');

    return this.create({
      telegramId,
      name,
      role,
      regionId: (store as { region_id: string }).region_id,
      storeId: (store as { id: string }).id,
    });
  }

  /**
   * Attach an already-onboarded user (e.g. MEGA_ADMIN with no store) to a
   * store, without touching their role. Used when someone else's invite/pilot
   * link is used just to "join" a store for visibility, not to onboard fresh.
   * No-op if the user already has a store.
   */
  async attachToStore(userId: string, storeId: string): Promise<UserRow> {
    const user = await this.requireUser(userId);
    if (user.store_id) return user;

    const { data: store, error: storeErr } = await this.supabase.db
      .from('stores')
      .select('id, region_id')
      .eq('id', storeId)
      .maybeSingle();
    if (storeErr) throw storeErr;
    if (!store) throw new BadRequestException('Store link is invalid.');

    const { error } = await this.supabase.db
      .from('users')
      .update({ store_id: storeId, region_id: (store as { region_id: string }).region_id })
      .eq('id', userId);
    if (error) throw error;

    return this.requireUser(userId);
  }

  /**
   * TEST-ONLY hard delete by telegram_id. Removes the user and everything that
   * FK-references them (reactions, work-items, authored lifehacks, invites) so
   * the row can actually be deleted. Nulls out stores.director_id pointing at
   * them. Returns false if no such user. Not for production use.
   */
  async deleteByTelegramId(telegramId: number): Promise<boolean> {
    const user = await this.findByTelegramId(telegramId);
    if (!user) return false;
    const uid = user.id;
    const db = this.supabase.db;

    // Reactions/work-items on lifehacks this user authored (from anyone).
    const { data: authored } = await db.from('lifehacks').select('id').eq('author_id', uid);
    const lifehackIds = (authored ?? []).map((r: { id: string }) => r.id);

    // Refuse once colleagues have actually reported results on this user's
    // cases: those outcomes are other people's work and the evidence the whole
    // scoring model runs on. Resetting a fresh test account stays easy; wiping
    // real history has to be a deliberate act, not a side effect of /reset.
    // Checked in BOTH directions: outcomes colleagues reported on this user's
    // cases, and outcomes this user reported on other people's cases. The
    // cascades below would erase either, and both are scoring evidence that
    // belongs to the platform rather than to the row being removed.
    const scored = [...SCORED_OUTCOMES];

    let onOwnCases = 0;
    if (lifehackIds.length) {
      const { count, error: e1 } = await db
        .from('work_items')
        .select('id', { count: 'exact', head: true })
        .in('lifehack_id', lifehackIds)
        .in('status', scored);
      if (e1) throw e1;
      onOwnCases = count ?? 0;
    }

    const { count: reportedCount, error: e2 } = await db
      .from('work_items')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', uid)
      .in('status', scored);
    if (e2) throw e2;
    const reportedByUser = reportedCount ?? 0;

    if (onOwnCases > 0 || reportedByUser > 0) {
      throw new BadRequestException(
        `Не можна видалити цього юзера: ${onOwnCases} підтверджень на його кейсах, ` +
          `${reportedByUser} результатів, які він підтвердив сам. ` +
          'Це історія, на якій тримається рейтинг кейсів.',
      );
    }

    await db.from('reactions').delete().eq('user_id', uid);
    await db.from('work_items').delete().eq('user_id', uid);
    if (lifehackIds.length) {
      await db.from('reactions').delete().in('lifehack_id', lifehackIds);
      await db.from('work_items').delete().in('lifehack_id', lifehackIds);
      await db.from('lifehacks').delete().in('id', lifehackIds);
    }
    await db.from('invites').delete().eq('created_by', uid);
    await db.from('invites').update({ used_by: null }).eq('used_by', uid);
    await db.from('stores').update({ director_id: null }).eq('director_id', uid);

    const { error } = await db.from('users').delete().eq('id', uid);
    if (error) throw error;
    return true;
  }

  /** List all stores with user counts (admin cleanup / overview). */
  async listStores(): Promise<Array<{ id: string; name: string; userCount: number }>> {
    const { data: stores, error } = await this.supabase.db
      .from('stores')
      .select('id, name')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const counts = await this.userCountsBy('store_id');
    return (stores ?? []).map((s) => ({
      id: s.id as string,
      name: s.name as string,
      userCount: counts.get(s.id as string) ?? 0,
    }));
  }

  /**
   * User counts grouped by store or region, in one query instead of one per
   * row. Only ids are fetched, so the payload stays small even at scale.
   */
  private async userCountsBy(column: 'store_id' | 'region_id'): Promise<Map<string, number>> {
    const { data, error } = await this.supabase.db.from('users').select(column);
    if (error) throw error;
    const counts = new Map<string, number>();
    (data ?? []).forEach((row) => {
      const key = (row as Record<string, string | null>)[column];
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }

  /**
   * Delete a store (and its region, if no other store uses it). Refuses if any
   * user is still attached, so we never orphan people — for cleaning up empty
   * duplicate stores. Returns 'ok' | 'not_found' | 'has_users'.
   */
  async deleteStore(storeId: string): Promise<'ok' | 'not_found' | 'has_users'> {
    const { data: store, error } = await this.supabase.db
      .from('stores')
      .select('id, region_id')
      .eq('id', storeId)
      .maybeSingle();
    if (error) throw error;
    if (!store) return 'not_found';

    const { count, error: cntErr } = await this.supabase.db
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId);
    if (cntErr) throw cntErr;
    if ((count ?? 0) > 0) return 'has_users';

    // No users left in the store → any leftover invite links are stale
    // (unused test invites, or the only user already left). Safe to drop.
    await this.supabase.db.from('invites').delete().eq('store_id', storeId);

    const regionId = (store as { region_id: string | null }).region_id;
    const { error: delErr } = await this.supabase.db.from('stores').delete().eq('id', storeId);
    if (delErr) throw delErr;

    // Drop the region too if nothing else references it (pilot regions are 1:1).
    if (regionId) {
      const { count: regUse } = await this.supabase.db
        .from('stores')
        .select('id', { count: 'exact', head: true })
        .eq('region_id', regionId);
      if ((regUse ?? 0) === 0) {
        await this.supabase.db.from('invites').delete().eq('region_id', regionId);
        await this.supabase.db.from('regions').delete().eq('id', regionId);
      }
    }
    return 'ok';
  }

  async me(userId: string): Promise<UserRow> {
    return this.requireUser(userId);
  }

  /**
   * Log a WebApp open. Fire-and-forget: a failure here must never block the
   * app from loading, so errors are swallowed.
   */
  async recordAppOpen(userId: string): Promise<void> {
    try {
      await this.supabase.db.from('app_opens').insert({ user_id: userId });
    } catch {
      /* non-critical telemetry */
    }
  }

  /** Platform-wide stats for the admin /stats command. */
  async platformStats(): Promise<{
    users: number;
    activeUsers: number;
    stores: number;
    regions: number;
    lifehacks: number;
    wc: Record<string, number>;
    confirmations: number;
    successRate: number;
    engaged: { authors: number; takers: number };
    opens: { total: number; today: number; week: number; uniqueWeek: number };
  }> {
    const db = this.supabase.db;
    const countOf = async (
      table: string,
      filter?: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
    ): Promise<number> => {
      let q = db.from(table).select('id', { count: 'exact', head: true });
      if (filter) q = filter(q);
      const { count } = await q;
      return count ?? 0;
    };

    const [users, activeUsers, stores, regions, lifehacks] = await Promise.all([
      countOf('users'),
      countOf('users', (q) => q.eq('status', 'active')),
      countOf('stores'),
      countOf('regions'),
      countOf('lifehacks', (q) => q.eq('status', 'published')),
    ]);

    const { data: wis } = await db.from('work_items').select('user_id, status');
    const wc: Record<string, number> = {
      in_work: 0,
      success: 0,
      partial: 0,
      fail: 0,
      not_tried: 0,
      expired: 0,
    };
    const takers = new Set<string>();
    (wis ?? []).forEach((w) => {
      if (wc[w.status as string] !== undefined) wc[w.status as string]++;
      takers.add(w.user_id as string);
    });

    const { data: authorsRows } = await db
      .from('lifehacks')
      .select('author_id')
      .eq('status', 'published');
    const authors = new Set((authorsRows ?? []).map((r) => r.author_id as string));

    // WebApp opens: total, today, last 7 days (+ distinct users this week).
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totalOpens, { data: weekOpens }, { data: todayOpens }] = await Promise.all([
      countOf('app_opens'),
      db.from('app_opens').select('user_id').gte('opened_at', weekAgo.toISOString()),
      db.from('app_opens').select('id').gte('opened_at', startOfDay.toISOString()),
    ]);
    const uniqueWeek = new Set((weekOpens ?? []).map((o) => o.user_id as string)).size;

    const confirmations = wc.success + wc.partial + wc.fail;
    const successRate = confirmations > 0 ? Math.round((wc.success / confirmations) * 100) : 0;
    return {
      users,
      activeUsers,
      stores,
      regions,
      lifehacks,
      wc,
      confirmations,
      successRate,
      engaged: { authors: authors.size, takers: takers.size },
      opens: {
        total: totalOpens,
        today: (todayOpens ?? []).length,
        week: (weekOpens ?? []).length,
        uniqueWeek,
      },
    };
  }

  /** Per-user activity (opens / written / taken / success) for `/users`. */
  async usersActivity(limit = 25): Promise<
    {
      name: string;
      role: string;
      written: number;
      taken: number;
      success: number;
      opens: number;
      lastSeen: string | null;
    }[]
  > {
    const db = this.supabase.db;
    const [usersRes, lhsRes, wisRes, opensRes] = await Promise.all([
      db.from('users').select('id, name, role'),
      db.from('lifehacks').select('author_id').eq('status', 'published'),
      db.from('work_items').select('user_id, status'),
      db.from('app_opens').select('user_id, opened_at'),
    ]);
    const written = new Map<string, number>();
    const taken = new Map<string, number>();
    const success = new Map<string, number>();
    const opens = new Map<string, number>();
    const lastSeen = new Map<string, string>();
    (lhsRes.data ?? []).forEach((l) =>
      written.set(l.author_id as string, (written.get(l.author_id as string) ?? 0) + 1),
    );
    (wisRes.data ?? []).forEach((w) => {
      taken.set(w.user_id as string, (taken.get(w.user_id as string) ?? 0) + 1);
      if (w.status === 'success')
        success.set(w.user_id as string, (success.get(w.user_id as string) ?? 0) + 1);
    });
    (opensRes.data ?? []).forEach((o) => {
      const uid = o.user_id as string;
      const at = o.opened_at as string;
      opens.set(uid, (opens.get(uid) ?? 0) + 1);
      const prev = lastSeen.get(uid);
      if (!prev || at > prev) lastSeen.set(uid, at);
    });
    const rows = (usersRes.data ?? []).map((u) => ({
      name: (u.name as string) || '—',
      role: u.role as string,
      written: written.get(u.id as string) ?? 0,
      taken: taken.get(u.id as string) ?? 0,
      success: success.get(u.id as string) ?? 0,
      opens: opens.get(u.id as string) ?? 0,
      lastSeen: lastSeen.get(u.id as string) ?? null,
    }));
    // Actions weigh more than opens, but opens break ties so browsers still rank.
    const score = (r: { written: number; taken: number; opens: number }): number =>
      (r.written + r.taken) * 100 + r.opens;
    rows.sort((a, b) => score(b) - score(a));
    return rows.slice(0, limit);
  }

  /** Display name of a store (for the WebApp header/profile). */
  async storeName(storeId: string | null): Promise<string | null> {
    if (!storeId) return null;
    const { data } = await this.supabase.db
      .from('stores')
      .select('name')
      .eq('id', storeId)
      .maybeSingle();
    return (data as { name: string } | null)?.name ?? null;
  }

  /** List all regions with user counts (admin cleanup). */
  async listRegionsWithCounts(): Promise<Array<{ id: string; name: string; userCount: number }>> {
    const { data: regions, error: regErr } = await this.supabase.db
      .from('regions')
      .select('id, name')
      .order('name', { ascending: true });
    if (regErr) throw regErr;

    const counts = await this.userCountsBy('region_id');
    return (regions ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      userCount: counts.get(r.id as string) ?? 0,
    }));
  }

  /**
   * Delete a region. Refuses if any users are attached. Returns 'ok' | 'not_found' | 'has_users'.
   */
  async deleteRegion(regionId: string): Promise<'ok' | 'not_found' | 'has_users'> {
    const { data: region, error } = await this.supabase.db
      .from('regions')
      .select('id')
      .eq('id', regionId)
      .maybeSingle();
    if (error) throw error;
    if (!region) return 'not_found';

    const { count, error: cntErr } = await this.supabase.db
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('region_id', regionId);
    if (cntErr) throw cntErr;
    if ((count ?? 0) > 0) return 'has_users';

    // No users left in the region → any leftover invite links are stale
    // (unused test invites, or ones whose only user already left). Safe to drop.
    await this.supabase.db.from('invites').delete().eq('region_id', regionId);

    const { error: delErr } = await this.supabase.db
      .from('regions')
      .delete()
      .eq('id', regionId);
    if (delErr) throw delErr;
    return 'ok';
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
