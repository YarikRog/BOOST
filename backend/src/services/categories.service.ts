import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../integrations/supabase.client';

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  sort_order: number;
  active: boolean;
}

/**
 * Categories are data (white-label). Each deploy seeds its own verticals
 * (migrations/0002_seed_categories.sql). The WebApp renders tabs from this list.
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(): Promise<CategoryRow[]> {
    const { data, error } = await this.supabase.db
      .from('categories')
      .select('*')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return (data as CategoryRow[]) ?? [];
  }
}
