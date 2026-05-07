import { ApiProperty } from '@nestjs/swagger';

export class ListMessagesDto {
  @ApiProperty()
  sessionId!: string;
}
