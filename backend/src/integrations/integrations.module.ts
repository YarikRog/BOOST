import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.client';
import { RedisService } from './redis.client';

/**
 * Global so every feature module can inject the two clients without re-importing.
 */
@Global()
@Module({
  providers: [SupabaseService, RedisService],
  exports: [SupabaseService, RedisService],
})
export class IntegrationsModule {}
