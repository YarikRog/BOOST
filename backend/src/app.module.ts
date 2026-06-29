import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { IntegrationsModule } from './integrations/integrations.module';
import { ScoringModule } from './services/scoring.module';
import { WorkItemsModule } from './services/work-items.module';
import { LifehacksModule } from './services/lifehacks.module';
import { CategoriesModule } from './services/categories.module';
import { UsersModule } from './services/users.module';
import { InvitesModule } from './services/invites.module';
import { AuthModule } from './auth/auth.module';
import { WorkersModule } from './workers/workers.module';
import { BotModule } from './bot/bot.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), // drives the sweep workers (Postgres is the clock)
    IntegrationsModule, // global: SupabaseService + RedisService
    ScoringModule,
    UsersModule,
    AuthModule,
    InvitesModule,
    WorkItemsModule,
    LifehacksModule,
    CategoriesModule,
    WorkersModule,
    BotModule,
  ],
})
export class AppModule {}
