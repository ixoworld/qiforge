import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { BYO_PROVIDERS, type ByoProvider } from '../../../llm/byo-catalog.js';

export class DevicePollDto {
  @IsString()
  @IsNotEmpty()
  deviceAuthId!: string;

  @IsString()
  @IsNotEmpty()
  userCode!: string;
}

export class CodeExchangeDto {
  /** Authorization code from the pasted localhost redirect URL. */
  @IsString()
  @IsNotEmpty()
  code!: string;

  /** PKCE verifier the client minted alongside the authorize URL. */
  @IsString()
  @IsNotEmpty()
  codeVerifier!: string;
}

export class ProviderParamDto {
  @IsIn(BYO_PROVIDERS)
  provider!: ByoProvider;
}

export class ApiKeySaveDto {
  /** The provider API key, stored server-encrypted in the canonical room. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  apiKey!: string;
}
