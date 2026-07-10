import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
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

  // GET /lifehacks/me/stats — real profile stats for the current user.
  @Get('me/stats')
  @UseGuards(TelegramInitDataGuard)
  myStats(@Req() req: AuthedRequest) {
    return this.lifehacks.authorStats(req.appUser.id);
  }

  // GET /lifehacks/feed?categorySlug=|categoryId=&audience=
  @Get('feed')
  feed(
    @Query('categoryId') categoryId: string,
    @Query('categorySlug') categorySlug: string,
    @Query('audience') audience: 'newcomer' | 'experienced' = 'experienced',
  ) {
    if (categorySlug) return this.lifehacks.feedBySlug(categorySlug, audience);
    return this.lifehacks.feed(categoryId, audience);
  }

  // GET /lifehacks/:id/voice — stream a voice case's audio (public; used by
  // the WebApp <audio> element which can't send the initData header).
  @Get(':id/voice')
  async voice(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const v = await this.lifehacks.voiceBuffer(id);
    if (!v) {
      res.status(404).send('no voice');
      return;
    }
    res.set('Content-Type', v.contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(v.buffer);
  }

  // GET /lifehacks/:id/quality — debug/inspection of the scoring output
  @Get(':id/quality')
  quality(@Param('id') id: string) {
    return this.lifehacks.qualityOf(id);
  }
}
