import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { WorkItemsService, ResolveOutcome } from '../services/work-items.service';
import { WorkItemStatus } from '../common/enums';
import { TelegramInitDataGuard, AuthedRequest } from '../auth/telegram-initdata.guard';

interface ResolveBody {
  outcome: 'success' | 'partial' | 'fail' | 'not_tried';
}

/**
 * Thin controller — validation + delegation only. The user is resolved from the
 * Telegram initData header (guard), never trusted from the client.
 */
@Controller()
export class WorkItemsController {
  constructor(private readonly workItems: WorkItemsService) {}

  // POST /lifehacks/:id/take
  @Post('lifehacks/:id/take')
  @UseGuards(TelegramInitDataGuard)
  take(@Param('id') lifehackId: string, @Req() req: AuthedRequest) {
    return this.workItems.take(req.appUser.id, lifehackId);
  }

  // POST /work-items/:id/result
  @Post('work-items/:id/result')
  @UseGuards(TelegramInitDataGuard)
  resolve(@Param('id') workItemId: string, @Body() body: ResolveBody, @Req() req: AuthedRequest) {
    const outcome = WorkItemStatus[body.outcome] as ResolveOutcome;
    return this.workItems.resolve(req.appUser.id, workItemId, outcome);
  }

  // GET /work-items/active
  @Get('work-items/active')
  @UseGuards(TelegramInitDataGuard)
  active(@Req() req: AuthedRequest) {
    return this.workItems.listActive(req.appUser.id);
  }
}
