import { Module } from '@nestjs/common';
import { TelegramAuthService } from './telegram-auth.service';
import { TelegramInitDataGuard } from './telegram-initdata.guard';
import { AuthController } from './auth.controller';
import { UsersModule } from '../services/users.module';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [TelegramAuthService, TelegramInitDataGuard],
  exports: [TelegramAuthService, TelegramInitDataGuard],
})
export class AuthModule {}
