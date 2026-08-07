import { IsEnum, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { UserRole, WorkItemStatus } from '../../common/enums';

/**
 * Runtime validation for every user-controlled HTTP payload. TypeScript
 * interfaces are erased at compile time and validate nothing at runtime, so
 * anything reaching a service must pass through one of these first.
 */

export class CreateLifehackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  categorySlug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  productType?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;
}

export class VoiceIntentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  categorySlug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  productType?: string;
}

export class ReactDto {
  @IsIn(['like', 'dislike'])
  type!: 'like' | 'dislike';
}

export class ResolveWorkItemDto {
  // Only the four user-reportable outcomes; in_work/expired are system-set.
  @IsIn([
    WorkItemStatus.success,
    WorkItemStatus.partial,
    WorkItemStatus.fail,
    WorkItemStatus.not_tried,
  ])
  outcome!: 'success' | 'partial' | 'fail' | 'not_tried';
}

export class CreateInviteDto {
  @IsEnum(UserRole)
  role!: UserRole;

  @IsOptional()
  @IsUUID()
  regionId?: string;
}

export class FeedQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  categorySlug?: string;
}
