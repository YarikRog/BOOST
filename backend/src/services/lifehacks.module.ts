import { Module } from '@nestjs/common';
import { LifehacksService } from './lifehacks.service';
import { LifehacksController } from '../api/lifehacks.controller';
import { ScoringModule } from './scoring.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from './users.module';

@Module({
  // AuthModule provides the guard; UsersModule provides UsersService, which the
  // guard depends on and which must resolve in this module's context.
  imports: [ScoringModule, AuthModule, UsersModule],
  controllers: [LifehacksController],
  providers: [LifehacksService],
  exports: [LifehacksService],
})
export class LifehacksModule {}
