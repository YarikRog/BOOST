import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { InvitesModule } from '../services/invites.module';
import { UsersModule } from '../services/users.module';

/**
 * Telegram bot layer — thin UI (TECH_ARCHITECTURE §8). Delegates to InvitesService
 * and UsersService; holds only Flow-1 step routing. Runs in the single backend deploy.
 */
@Module({
  imports: [InvitesModule, UsersModule],
  providers: [BotService],
})
export class BotModule {}
