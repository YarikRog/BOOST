import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { InvitesService } from '../services/invites.service';
import { TelegramInitDataGuard, AuthedRequest } from '../auth/telegram-initdata.guard';
import { CreateInviteDto } from './dto';

@Controller('invites')
@UseGuards(TelegramInitDataGuard)
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** POST /invites — caller (from initData) issues an invite for a lower role. */
  @Post()
  create(@Req() req: AuthedRequest, @Body() body: CreateInviteDto) {
    return this.invites.create(req.appUser, body.role, { regionId: body.regionId });
  }
}
