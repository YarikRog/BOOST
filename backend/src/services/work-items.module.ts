import { Module, forwardRef } from '@nestjs/common';
import { WorkItemsService } from './work-items.service';
import { WorkItemsController } from '../api/work-items.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from './users.module';
import { BotModule } from '../bot/bot.module';

@Module({
  // AuthModule provides the guard; UsersModule its UsersService; BotModule the
  // BotService used to forward voice cases to the taker.
  imports: [AuthModule, UsersModule, forwardRef(() => BotModule)],
  controllers: [WorkItemsController],
  providers: [WorkItemsService],
  exports: [WorkItemsService],
})
export class WorkItemsModule {}
