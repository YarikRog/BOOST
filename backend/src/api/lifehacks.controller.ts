import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { LifehacksService } from '../services/lifehacks.service';
import { TelegramInitDataGuard, AuthedRequest } from '../auth/telegram-initdata.guard';

interface CreateBody {
  categorySlug: string;
  productType?: string;
  title: string;
  content?: Record<string, unknown>;
}

@Controller('lifehacks')
export class LifehacksController {
  constructor(private readonly lifehacks: LifehacksService) {}

  // POST /lifehacks — create + publish (WebApp create flow). Auth via initData.
  @Post()
  @UseGuards(TelegramInitDataGuard)
  create(@Body() body: CreateBody, @Req() req: AuthedRequest) {
    return this.lifehacks.create(req.appUser, {
      categorySlug: body.categorySlug,
      productType: body.productType ?? '',
      title: body.title,
      content: body.content ?? {},
    });
  }

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
