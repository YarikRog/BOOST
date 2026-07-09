import { Module } from '@nestjs/common';
import { WorkItemsService } from './work-items.service';
import { WorkItemsController } from '../api/work-items.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from './users.module';

@Module({
  // AuthModule provides the guard; UsersModule provides UsersService it needs.
  imports: [AuthModule, UsersModule],
  controllers: [WorkItemsController],
  providers: [WorkItemsService],
  exports: [WorkItemsService],
})
export class WorkItemsModule {}
