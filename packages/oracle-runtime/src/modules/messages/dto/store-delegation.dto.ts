import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

/**
 * Body for `POST /delegation`. The client posts a freshly-signed user→oracle
 * UCAN delegation (base64 CAR) after re-authorizing in the app. The
 * delegation is authorization-only and safe to expose.
 */
export class StoreDelegationDto {
  @ApiProperty({
    description: 'Base64-encoded UCAN delegation CAR (user → oracle).',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  raw!: string;

  @ApiProperty({
    description: 'Delegation issuer DID (the user).',
    required: false,
    type: String,
  })
  @IsOptional()
  @IsString()
  issuer?: string;

  @ApiProperty({
    description: 'Delegation audience DID (this oracle).',
    required: false,
    type: String,
  })
  @IsOptional()
  @IsString()
  audience?: string;

  @ApiProperty({
    description: 'Delegation expiration as a unix timestamp (seconds).',
    required: false,
    type: Number,
  })
  @IsOptional()
  @IsNumber()
  expiration?: number;
}
