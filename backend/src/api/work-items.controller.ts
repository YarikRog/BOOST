import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WorkItemsService, ResolveOutcome } from '../services/work-items.service';
import { WorkItemStatus } from '../common/enums';

interface ResolveBody {
  outcome: 'success' | 'partial' | 'fail' | 'not_tried';
}

/**
 * Thin controller — validation + delegation only, no business logic
 * (TECH_ARCHITECTURE §9). Auth/user resolution is stubbed via query/param for
 * the skeleton; real impl derives userId from Telegram initData.
 */
@Controller()
export class WorkItemsController {
  constructor(private readonly workItems: WorkItemsService) {}

  // POST /lifehacks/:id/take
  @Post('lifehacks/:id/take')
  take(@Param('id') lifehackId: string, @Query('userId') userId: string) {
    return this.workItems.take(userId, lifehackId);
  }

  // POST /work-items/:id/result
  @Post('work-items/:id/result')
  resolve(@Param('id') workItemId: string, @Body() body: ResolveBody) {
    const outcome = WorkItemStatus[body.outcome] as ResolveOutcome;
    return this.workItems.resolve(workItemId, outcome);
  }

  // GET /work-items/active
  @Get('work-items/active')
  active(@Query('userId') userId: string) {
    return this.workItems.listActive(userId);
  }
}
