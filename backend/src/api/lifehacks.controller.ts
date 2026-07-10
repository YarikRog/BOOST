import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { LifehacksService } from '../services/lifehacks.service';
import { TelegramInitDataGuard, AuthedRequest } from '../auth/telegram-initdata.guard';

interface CreateBody {
  categorySlug: string;
  productType?: string;
  title: string;
  content?: Record<string, unknown>;
}

interface VoiceIntentBody {
  categorySlug: string;
  productType?: string;
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

  // POST /lifehacks/voice-intent — remember chosen category before recording.
  @Post('voice-intent')
  @UseGuards(TelegramInitDataGuard)
  voiceIntent(@Body() body: VoiceIntentBody, @Req() req: AuthedRequest) {
    return this.lifehacks.setVoiceIntent(req.appUser.telegram_id, {
      categorySlug: body.categorySlug,
      productType: body.productType ?? '',
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
