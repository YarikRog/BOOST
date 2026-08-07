import { Module, forwardRef } from '@nestjs/common';
import { LifehacksService } from './lifehacks.service';
import { LifehacksController } from '../api/lifehacks.controller';
import { ScoringModule } from './scoring.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from './users.module';
import { BotModule } from '../bot/bot.module';

@Module({
  // AuthModule provides the guard; UsersModule provides UsersService, which the
  // guard depends on and which must resolve in this module's context.
  // forwardRef on BotModule: BotService also needs LifehacksService (voice
  // case publish flow), so the two modules depend on each other.
  imports: [ScoringModule, AuthModule, UsersModule, forwardRef(() => BotModule)],
  controllers: [LifehacksController],
  providers: [LifehacksService],
  exports: [LifehacksService],
})
export class LifehacksModule {}
