import { Module, forwardRef } from '@nestjs/common';
import { BotService } from './bot.service';
import { InvitesModule } from '../services/invites.module';
import { UsersModule } from '../services/users.module';
import { LifehacksModule } from '../services/lifehacks.module';
import { CategoriesModule } from '../services/categories.module';

/**
 * Telegram bot layer — thin UI (TECH_ARCHITECTURE §8). Delegates to services;
 * holds only step routing. Exports BotService so work-items can forward voice
 * cases to the taker. Runs in the single backend deploy.
 *
 * forwardRef on LifehacksModule: LifehacksService also needs BotService (to
 * broadcast "new lifehack" pings), so the two modules depend on each other.
 */
@Module({
  imports: [InvitesModule, UsersModule, forwardRef(() => LifehacksModule), CategoriesModule],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
