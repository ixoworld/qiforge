import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const ANONYMOUS_FEEDBACK_SURFACES = [
  'workspace',
  'agentSidebar',
] as const;
export const ANONYMOUS_FEEDBACK_THEMES = ['dark', 'light'] as const;
export const ANONYMOUS_FEEDBACK_DEVICE_CLASSES = [
  'mobile',
  'tablet',
  'desktop',
] as const;
export const ANONYMOUS_FEEDBACK_VIEWPORT_BUCKETS = [
  'compact',
  'medium',
  'wide',
] as const;
export const ANONYMOUS_FEEDBACK_NETWORKS = [
  'mainnet',
  'testnet',
  'devnet',
  'unknown',
] as const;

export type AnonymousFeedbackSurface =
  (typeof ANONYMOUS_FEEDBACK_SURFACES)[number];
export type AnonymousFeedbackTheme = (typeof ANONYMOUS_FEEDBACK_THEMES)[number];
export type AnonymousFeedbackDeviceClass =
  (typeof ANONYMOUS_FEEDBACK_DEVICE_CLASSES)[number];
export type AnonymousFeedbackViewportBucket =
  (typeof ANONYMOUS_FEEDBACK_VIEWPORT_BUCKETS)[number];
export type AnonymousFeedbackNetwork =
  (typeof ANONYMOUS_FEEDBACK_NETWORKS)[number];

export class AnonymousMessageFeedbackContextDto {
  @ApiProperty({ enum: ANONYMOUS_FEEDBACK_SURFACES })
  @IsIn(ANONYMOUS_FEEDBACK_SURFACES)
  surface: AnonymousFeedbackSurface;

  @ApiProperty({ example: 'en' })
  @IsString()
  @Matches(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
  @MaxLength(20)
  locale: string;

  @ApiProperty({ enum: ANONYMOUS_FEEDBACK_THEMES })
  @IsIn(ANONYMOUS_FEEDBACK_THEMES)
  theme: AnonymousFeedbackTheme;

  @ApiProperty({ enum: ANONYMOUS_FEEDBACK_DEVICE_CLASSES })
  @IsIn(ANONYMOUS_FEEDBACK_DEVICE_CLASSES)
  deviceClass: AnonymousFeedbackDeviceClass;

  @ApiProperty({ enum: ANONYMOUS_FEEDBACK_VIEWPORT_BUCKETS })
  @IsIn(ANONYMOUS_FEEDBACK_VIEWPORT_BUCKETS)
  viewportBucket: AnonymousFeedbackViewportBucket;

  @ApiProperty({ enum: ANONYMOUS_FEEDBACK_NETWORKS })
  @IsIn(ANONYMOUS_FEEDBACK_NETWORKS)
  network: AnonymousFeedbackNetwork;

  @ApiPropertyOptional({ example: '4f2ea36f781a' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  portalBuildVersion?: string;
}

export class SubmitAnonymousMessageFeedbackDto {
  @ApiProperty({ description: 'Client-generated idempotency key' })
  @IsUUID('4')
  submissionId: string;

  @ApiProperty({
    description: 'Anonymous feedback about one completed Agent response',
    minLength: 1,
    maxLength: 2000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  feedback: string;

  @ApiProperty({ type: AnonymousMessageFeedbackContextDto })
  @ValidateNested()
  @Type(() => AnonymousMessageFeedbackContextDto)
  context: AnonymousMessageFeedbackContextDto;
}

export interface AnonymousMessageFeedbackResponse {
  submissionId: string;
  status: 'submitted';
  submittedAt: string;
}
