import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { SupabaseService } from './integrations/supabase.client';
import { RedisService } from './integrations/redis.client';
import { BotService } from './bot/bot.service';
import { WorkItemsService } from './services/work-items.service';
import { LifehacksService } from './services/lifehacks.service';

/**
 * Boots the real module graph with only the external clients stubbed.
 *
 * This exists because circular module dependencies (BotService ⇄ WorkItemsService
 * ⇄ LifehacksService, wired with forwardRef) resolve at runtime, not at compile
 * time: a missing forwardRef type-checks and builds cleanly, then throws on
 * startup in production. Nothing else in the suite would catch that.
 */
describe('AppModule dependency graph', () => {
  const build = () =>
    Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SupabaseService)
      .useValue({ db: {} })
      .overrideProvider(RedisService)
      .useValue({ client: {} })
      .compile();

  it('resolves every provider, including the forwardRef cycles', async () => {
    const moduleRef = await build();

    // Each of these sits on a cycle; getting a real instance proves the cycle
    // is wired in both directions.
    expect(moduleRef.get(BotService, { strict: false })).toBeInstanceOf(BotService);
    expect(moduleRef.get(WorkItemsService, { strict: false })).toBeInstanceOf(WorkItemsService);
    expect(moduleRef.get(LifehacksService, { strict: false })).toBeInstanceOf(LifehacksService);

    await moduleRef.close();
  });

  it('injects WorkItemsService into BotService so resolve has one implementation', async () => {
    const moduleRef = await build();
    const bot = moduleRef.get(BotService, { strict: false });

    // Guards the de-duplication: the bot must delegate outcome writes rather
    // than re-implementing the ownership and status rules inline.
    expect((bot as unknown as { workItems: unknown }).workItems).toBeInstanceOf(WorkItemsService);

    await moduleRef.close();
  });
});
