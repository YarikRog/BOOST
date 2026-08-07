import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoriesController } from '../api/categories.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from './users.module';

@Module({
  // AuthModule provides the guard; UsersModule the UsersService it depends on.
  imports: [AuthModule, UsersModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
