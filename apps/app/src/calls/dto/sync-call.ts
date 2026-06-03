import { OraclesCallMatrixEvent } from '@ixo/matrix';
import { ApiProperty } from '@nestjs/swagger';
import { CallId } from './types';

type TOraclesCallMatrixEventContent = OraclesCallMatrixEvent['content'];

export class OraclesCallMatrixEventContent implements TOraclesCallMatrixEventContent {
  @ApiProperty({
    description: 'Matrix event type identifier',
    example: 'm.ixo.oracles_call',
    readOnly: true,
  })
  type: 'm.ixo.oracles_call';

  @ApiProperty({
    description: 'Unique identifier for the session',
    example: '550e8400-e29b-41d4-a716-446655440000',
    readOnly: true,
  })
  sessionId: string;

  @ApiProperty({
    description: 'User did',
    example: 'did:ixo:1234567890',
  })
  userDid: string;

  @ApiProperty({
    description: 'Oracle did',
    example: 'did:ixo:1234567890',
  })
  oracleDid: string;

  @ApiProperty({
    description: 'Type of the call',
    enum: ['audio', 'video'],
    example: 'video',
  })
  callType: 'audio' | 'video';

  @ApiProperty({
    description: 'Current status of the call',
    enum: ['active', 'ended', 'pending'],
    example: 'pending',
  })
  callStatus: 'active' | 'ended' | 'pending';

  @ApiProperty({
    description: 'ISO 8601 timestamp when the call started',
    example: '2024-01-01T10:00:00.000Z',
    required: false,
  })
  callStartedAt?: string;

  @ApiProperty({
    description: 'ISO 8601 timestamp when the call ended',
    example: '2024-01-01T10:30:00.000Z',
    required: false,
  })
  callEndedAt?: string;

  @ApiProperty({
    description: 'Encrypted key for secure call communication',
    example: 'a1b2c3d4e5f6789012345678901234567890abcdef...',
    readOnly: true,
  })
  encryptionKey: string;
}

export class SyncCallResponse {
  @ApiProperty({
    description: 'Unique identifier for the call',
    example: '550e8400-e29b-41d4-a716-446655440000@lk-room-12345',
  })
  callId: CallId;
}
