import { Module } from '@nestjs/common';
import { LifehacksService } from './lifehacks.service';
import { LifehacksController } from '../api/lifehacks.controller';
import { ScoringModule } from './scoring.module';

@Module({
  imports: [ScoringModule],
  controllers: [LifehacksController],
  providers: [LifehacksService],
  exports: [LifehacksService],
})
export class LifehacksModule {}
