import { Module } from '@nestjs/common';
import { LifehacksService } from './lifehacks.service';
import { LifehacksController } from '../api/lifehacks.controller';
import { ScoringModule } from './scoring.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ScoringModule, AuthModule], // AuthModule provides TelegramInitDataGuard
  controllers: [LifehacksController],
  providers: [LifehacksService],
  exports: [LifehacksService],
})
export class LifehacksModule {}
