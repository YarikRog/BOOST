import { Module } from '@nestjs/common';
import { ScoringService } from './scoring.service';
import { RankingService } from './ranking.service';

/** The quality/ordering brain: one scoring definition, one ranking definition. */
@Module({
  providers: [ScoringService, RankingService],
  exports: [ScoringService, RankingService],
})
export class ScoringModule {}
