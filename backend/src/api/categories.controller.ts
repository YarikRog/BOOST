import { Controller, Get, UseGuards } from '@nestjs/common';
import { CategoriesService } from '../services/categories.service';
import { TelegramInitDataGuard } from '../auth/telegram-initdata.guard';

@Controller('categories')
@UseGuards(TelegramInitDataGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  // GET /categories — active verticals for this deploy (feed tabs).
  @Get()
  list() {
    return this.categories.list();
  }
}
