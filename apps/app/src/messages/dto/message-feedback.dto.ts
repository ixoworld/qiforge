import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const MESSAGE_FEEDBACK_VALUES = ['approved', 'disapproved'] as const;

export type MessageFeedback = (typeof MESSAGE_FEEDBACK_VALUES)[number];

export class SetMessageFeedbackDto {
  @ApiProperty({
    description: 'The authenticated user feedback for an Agent response',
    enum: MESSAGE_FEEDBACK_VALUES,
    example: 'approved',
  })
  @IsIn(MESSAGE_FEEDBACK_VALUES)
  feedback: MessageFeedback;
}

export interface MessageFeedbackResponse {
  sessionId: string;
  messageId: string;
  feedback: MessageFeedback | null;
  updatedAt: string;
}
