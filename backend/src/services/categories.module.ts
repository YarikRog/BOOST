import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoriesController } from '../api/categories.controller';

@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
