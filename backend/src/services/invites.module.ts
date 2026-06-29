import { Module } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { InvitesController } from '../api/invites.controller';
import { UsersModule } from './users.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [UsersModule, AuthModule],
  controllers: [InvitesController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
