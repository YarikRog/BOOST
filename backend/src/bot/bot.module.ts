import { Module, forwardRef } from '@nestjs/common';
import { BotService } from './bot.service';
import { InvitesModule } from '../services/invites.module';
import { UsersModule } from '../services/users.module';
import { LifehacksModule } from '../services/lifehacks.module';
import { CategoriesModule } from '../services/categories.module';
import { WorkItemsModule } from '../services/work-items.module';

/**
 * Telegram bot layer — thin UI (TECH_ARCHITECTURE §8). Delegates to services;
 * holds only step routing. Exports BotService so work-items can forward voice
 * cases to the taker. Runs in the single backend deploy.
 *
 * forwardRef on LifehacksModule and WorkItemsModule: both of those services
 * also need BotService (broadcast pings, voice forwarding, author notifications),
 * so the modules depend on each other in both directions.
 */
@Module({
  imports: [
    InvitesModule,
    UsersModule,
    forwardRef(() => LifehacksModule),
    forwardRef(() => WorkItemsModule),
    CategoriesModule,
  ],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
