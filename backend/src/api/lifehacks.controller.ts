import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { LifehacksService } from '../services/lifehacks.service';
import { TelegramInitDataGuard, AuthedRequest } from '../auth/telegram-initdata.guard';
import { TelegramAuthService } from '../auth/telegram-auth.service';
import { UsersService } from '../services/users.service';
import { CreateLifehackDto, FeedQueryDto, ReactDto, VoiceIntentDto } from './dto';

@Controller('lifehacks')
export class LifehacksController {
  constructor(
    private readonly lifehacks: LifehacksService,
    private readonly auth: TelegramAuthService,
    private readonly users: UsersService,
  ) {}

  // POST /lifehacks — create + publish (WebApp create flow). Auth via initData.
  @Post()
  @UseGuards(TelegramInitDataGuard)
  create(@Body() body: CreateLifehackDto, @Req() req: AuthedRequest) {
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
  voiceIntent(@Body() body: VoiceIntentDto, @Req() req: AuthedRequest) {
    return this.lifehacks.setVoiceIntent(req.appUser.telegram_id, {
      categorySlug: body.categorySlug,
      productType: body.productType ?? '',
    });
  }

  // POST /lifehacks/:id/delete — author or admin archives a case.
  @Post(':id/delete')
  @UseGuards(TelegramInitDataGuard)
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    const isAdmin =
      req.appUser.role === 'MEGA_ADMIN' || req.appUser.role === 'REGIONAL_IT_LEAD';
    return this.lifehacks.remove(req.appUser.id, isAdmin, id);
  }

  // POST /lifehacks/:id/react — toggle like/dislike.
  @Post(':id/react')
  @UseGuards(TelegramInitDataGuard)
  react(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReactDto, @Req() req: AuthedRequest) {
    return this.lifehacks.react(req.appUser, id, body.type);
  }

  // GET /lifehacks/my-reactions — the current user's reactions.
  @Get('my-reactions')
  @UseGuards(TelegramInitDataGuard)
  myReactions(@Req() req: AuthedRequest) {
    return this.lifehacks.myReactions(req.appUser.id);
  }

  // GET /lifehacks/me/stats — real profile stats for the current user.
  @Get('me/stats')
  @UseGuards(TelegramInitDataGuard)
  myStats(@Req() req: AuthedRequest) {
    return this.lifehacks.authorStats(req.appUser.id);
  }

  // GET /lifehacks/feed?categorySlug=|categoryId=
  // Audience is derived from the authenticated user's experience segment — it is
  // a ranking input, so it must never be client-supplied.
  @Get('feed')
  @UseGuards(TelegramInitDataGuard)
  feed(@Query() query: FeedQueryDto, @Req() req: AuthedRequest) {
    const audience = LifehacksService.audienceOf(req.appUser.experience_segment);
    if (query.categorySlug) return this.lifehacks.feedBySlug(query.categorySlug, audience);
    return this.lifehacks.feed(query.categoryId ?? '', audience);
  }

  /**
   * GET /lifehacks/:id/voice?initData=... — fallback audio stream for voice
   * cases whose Storage upload failed. The WebApp `<audio>` element cannot send
   * custom headers, so initData is accepted as a query param here and verified
   * with the same HMAC check the guard uses. Never unauthenticated.
   */
  @Get(':id/voice')
  async voice(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('initData') initData: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!initData) {
      res.status(401).send('unauthorized');
      return;
    }
    try {
      const tgUser = this.auth.validate(initData);
      const appUser = await this.users.findByTelegramId(tgUser.id);
      if (!appUser) {
        res.status(401).send('unauthorized');
        return;
      }
    } catch {
      res.status(401).send('unauthorized');
      return;
    }

    const v = await this.lifehacks.voiceBuffer(id);
    if (!v) {
      res.status(404).send('no voice');
      return;
    }
    res.set('Content-Type', v.contentType);
    // Per-user authorized content — must not be stored by shared caches.
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(v.buffer);
  }

  // GET /lifehacks/:id/quality — scoring breakdown for a case.
  @Get(':id/quality')
  @UseGuards(TelegramInitDataGuard)
  quality(@Param('id', ParseUUIDPipe) id: string) {
    return this.lifehacks.qualityOf(id);
  }
}
