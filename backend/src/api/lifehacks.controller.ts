import { Controller, Get, Param, Query } from '@nestjs/common';
import { LifehacksService } from '../services/lifehacks.service';
import { Category } from '../common/enums';

@Controller('lifehacks')
export class LifehacksController {
  constructor(private readonly lifehacks: LifehacksService) {}

  // GET /lifehacks/feed?category=&audience=
  @Get('feed')
  feed(
    @Query('category') category: Category,
    @Query('audience') audience: 'newcomer' | 'experienced' = 'experienced',
  ) {
    return this.lifehacks.feed(category, audience);
  }

  // GET /lifehacks/:id/quality — debug/inspection of the scoring output
  @Get(':id/quality')
  quality(@Param('id') id: string) {
    return this.lifehacks.qualityOf(id);
  }
}
