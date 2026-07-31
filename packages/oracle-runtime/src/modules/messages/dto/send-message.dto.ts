import { type ListOracleMessagesResponse } from '@ixo/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class BrowserToolCallDto {
  @ApiProperty({
    description: 'The tool name',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({
    description: 'The tool schema to be passed to the LLM',
    required: true,
    type: Object,
  })
  @IsNotEmpty()
  @IsObject()
  schema!: Record<string, unknown>;

  @ApiProperty({
    description: 'The tool description to be passed to the LLM',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  description!: string;
}

export class AgActionDto {
  @ApiProperty({
    description: 'The action name',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({
    description: 'The action description to be passed to the LLM',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  description!: string;

  @ApiProperty({
    description: 'The action parameters schema to be passed to the LLM',
    required: true,
    type: Object,
  })
  @IsNotEmpty()
  @IsObject()
  schema!: Record<string, unknown>;

  @ApiProperty({
    description: 'Whether this action has a render function',
    required: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  hasRender?: boolean;
}

export class AttachmentDto {
  @ApiProperty({
    description:
      'The content URI (mxc://homeserver/content_id or https://...). Required when eventId is not provided.',
    required: false,
    type: String,
    example: 'mxc://matrix.org/abc123',
  })
  @ValidateIf((o) => !o.eventId)
  @IsNotEmpty({ message: 'Either mxcUri or eventId must be provided' })
  @IsString()
  @Matches(/^(mxc|https?):\/\/.+/, {
    message: 'mxcUri must start with mxc://, http://, or https://',
  })
  mxcUri?: string;

  @ApiProperty({
    description:
      'Matrix event ID for encrypted file downloads. Required when mxcUri is not provided.',
    required: false,
    type: String,
    example: '$abc123',
  })
  @ValidateIf((o) => !o.mxcUri)
  @IsNotEmpty({ message: 'Either mxcUri or eventId must be provided' })
  @IsString()
  @Matches(/^\$/, { message: 'eventId must start with $' })
  eventId?: string;

  @ApiProperty({
    description: 'The original filename',
    required: true,
    type: String,
    example: 'report.pdf',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  filename!: string;

  @ApiProperty({
    description: 'The MIME type of the file',
    required: true,
    type: String,
    example: 'application/pdf',
  })
  @IsNotEmpty()
  @IsString()
  mimetype!: string;

  @ApiProperty({
    description: 'The file size in bytes',
    required: false,
    type: Number,
  })
  @IsOptional()
  @IsNumber()
  size?: number;
}

export class SendMessageDto {
  @ApiProperty({
    description: 'Whether to stream the response',
    required: false,
    default: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  @ApiProperty({
    description:
      'When true (non-stream only), the response includes the full transcript of messages from the session in addition to the last assistant message. Intended for testing — defaults to false.',
    required: false,
    default: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  returnAllMessages?: boolean;

  @ApiProperty({
    description: 'The message content to be sent',
    required: true,
    example: 'Hello, how can I get help with my account?',
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  message!: string;

  @ApiProperty({
    description:
      'Optional model id to answer this message with. Must be one of the ids returned by GET /models; an unknown or omitted value falls back to the oracle default model.',
    required: false,
    example: 'openai/gpt-5.6-luna',
    type: String,
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiProperty({
    description: 'The tool list to be passed to the LLM',
    required: false,
    type: [BrowserToolCallDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BrowserToolCallDto)
  tools?: BrowserToolCallDto[];

  @ApiProperty({
    description: 'The AG-UI action list to be passed to the LLM',
    required: false,
    type: [AgActionDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgActionDto)
  agActions?: AgActionDto[];

  @ApiProperty({
    description: 'The metadata to be passed to the LLM',
    required: false,
    type: Object,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown> & {
    editorRoomId?: string;
    spaceId?: string;
  };

  @ApiProperty({
    description: 'User timezone (e.g., "America/New_York" or "UTC-5")',
    required: false,
    type: String,
    example: 'America/New_York',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({
    description: 'The user home server',
    required: false,
    type: String,
  })
  @IsOptional()
  @IsString()
  homeServer?: string;

  @ApiProperty({
    description:
      'UCAN invocations for protected MCP tools. Map of tool names to base64-encoded CAR invocations.',
    required: false,
    type: Object,
    example: {
      postgres__query:
        'OqJlcm9vdHOB2CpYJQABcRIg... (base64-encoded CAR invocation)',
    },
  })
  @IsOptional()
  @IsObject()
  mcpInvocations?: Record<string, string>;

  @ApiProperty({
    description: 'File attachments uploaded to Matrix (max 10)',
    required: false,
    type: [AttachmentDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}

export class SendMessagePayload {
  stream?: boolean;
  returnAllMessages?: boolean;
  message!: string;
  sessionId!: string;
  did!: string;
  /**
   * Client-supplied request id for streaming requests (the SDK sends one so
   * it can correlate SSE events). Resolved to a fresh UUID by
   * `MessagesService` when absent, BEFORE the SSE headers flush — the id is
   * part of the `X-Request-Id` response header.
   */
  requestId?: string;
  /** Optional per-request model id; validated against the catalog allow-list. */
  model?: string;
  tools?: BrowserToolCallDto[];
  agActions?: AgActionDto[];
  timezone?: string;
  homeServer?: string;

  metadata?: {
    editorRoomId?: string;
    currentEntityDid?: string;
    spaceId?: string;
  };

  /**
   * UCAN invocations for protected MCP tools.
   * Map of tool names (e.g., "postgres__query") to base64-encoded CAR invocations.
   */
  mcpInvocations?: Record<string, string>;

  attachments?: AttachmentDto[];
}

/**
 * Shape returned by `POST /messages/:sessionId` when `stream` is false.
 * `messages` is only present when the request set `returnAllMessages: true`.
 */
export interface SendMessageResponse {
  message: { type: string; content: string; id: string };
  sessionId: string;
  messages?: ListOracleMessagesResponse['messages'];
}

export class AbortRequestDto {
  @ApiProperty({
    description: 'The session ID to abort',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  sessionId!: string;
}
