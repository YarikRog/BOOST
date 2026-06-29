import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { InvitesService } from '../services/invites.service';
import { TelegramInitDataGuard, AuthedRequest } from '../auth/telegram-initdata.guard';
import { UserRole } from '../common/enums';

interface CreateInviteBody {
  role: UserRole;
  regionId?: string; // required only when a MEGA_ADMIN invites a REGIONAL_IT_LEAD
}

@Controller('invites')
@UseGuards(TelegramInitDataGuard)
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** POST /invites — caller (from initData) issues an invite for a lower role. */
  @Post()
  create(@Req() req: AuthedRequest, @Body() body: CreateInviteBody) {
    return this.invites.create(req.appUser, body.role, { regionId: body.regionId });
  }
}
