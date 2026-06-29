import { Controller, Get } from '@nestjs/common';
import { CategoriesService } from '../services/categories.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  // GET /categories — active verticals for this deploy (feed tabs).
  @Get()
  list() {
    return this.categories.list();
  }
}
