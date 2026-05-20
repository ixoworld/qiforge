import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { type UserContextData } from '../memory-engine/types.js';

export class UserAuthDto {
  @IsString()
  @IsNotEmpty()
  did: string;

  @IsString()
  @IsOptional()
  homeServer?: string;
}

export class ListChatSessionsDto extends UserAuthDto {
  @IsString()
  @IsNotEmpty()
  oracleEntityDid: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  offset?: number;

  /** Filter sessions by roomId. When set, only sessions in this room are returned. */
  @IsString()
  @IsOptional()
  roomId?: string;
}

export class CreateChatSessionDto extends UserAuthDto {
  @IsString()
  @IsNotEmpty()
  oracleDid: string;

  @IsString()
  @IsNotEmpty()
  oracleEntityDid: string;

  @IsString()
  @IsNotEmpty()
  oracleName: string;

  @IsString()
  @IsOptional()
  slackThreadTs?: string;

  /** Override the roomId stored on the session (e.g. task-specific room). */
  @IsString()
  @IsOptional()
  roomId?: string;
}

export class DeleteChatSessionDto extends UserAuthDto {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsString()
  @IsNotEmpty()
  oracleEntityDid: string;
}

export class ChatSession {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsNotEmpty()
  lastUpdatedAt: string;

  @IsString()
  @IsNotEmpty()
  createdAt: string;

  @IsString()
  @IsNotEmpty()
  oracleName: string;

  @IsString()
  @IsNotEmpty()
  oracleDid: string;

  @IsString()
  @IsNotEmpty()
  oracleEntityDid: string;

  @IsNumber()
  @IsNotEmpty()
  lastProcessedCount?: number;

  @IsOptional()
  userContext?: UserContextData;

  @IsString()
  @IsOptional()
  roomId?: string;

  @IsString()
  @IsOptional()
  slackThreadTs?: string;
}

export class ListChatSessionsResponseDto {
  @IsArray()
  @IsNotEmpty()
  sessions: ChatSession[];

  @IsNumber()
  @IsOptional()
  total?: number;
}

export class CreateChatSessionResponseDto extends ChatSession {}
