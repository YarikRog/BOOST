import { Controller, Get, Param, Query } from '@nestjs/common';
import { LifehacksService } from '../services/lifehacks.service';

@Controller('lifehacks')
export class LifehacksController {
  constructor(private readonly lifehacks: LifehacksService) {}

  // GET /lifehacks/feed?categoryId=&audience=
  @Get('feed')
  feed(
    @Query('categoryId') categoryId: string,
    @Query('audience') audience: 'newcomer' | 'experienced' = 'experienced',
  ) {
    return this.lifehacks.feed(categoryId, audience);
  }

  // GET /lifehacks/:id/quality — debug/inspection of the scoring output
  @Get(':id/quality')
  quality(@Param('id') id: string) {
    return this.lifehacks.qualityOf(id);
  }
}
