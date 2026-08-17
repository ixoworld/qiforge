import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AbortRequestDto, SendMessageDto } from './dto/send-message.dto';
import { SubmitAnonymousMessageFeedbackDto } from './dto/message-feedback.dto';
import { MessagesService } from './messages.service';

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('abort')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abort an ongoing stream request' })
  @ApiResponse({ status: 200, description: 'Request aborted successfully.' })
  @ApiResponse({
    status: 200,
    description: 'No active request found for session.',
  })
  async abortRequest(@Body() abortRequestDto: AbortRequestDto) {
    const success = this.messagesService.abortRequest(
      abortRequestDto.sessionId,
    );
    return { success };
  }

  @Get(':sessionId')
  @ApiOperation({ summary: 'List messages in a session' })
  @ApiParam({
    name: 'sessionId',
    required: true,
    description: 'ID of the session to list messages for',
  })
  @ApiResponse({ status: 200, description: 'Messages retrieved successfully.' })
  @ApiResponse({
    status: 400,
    description: 'Bad Request (e.g., missing/invalid parameters).',
  })
  @ApiResponse({
    status: 404,
    description: 'Room not found or User not in room.',
  })
  async listMessages(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
  ) {
    const { did, homeServer } = req.authData;
    return this.messagesService.listMessages({
      sessionId,
      did,
      homeServer,
    });
  }

  @Post(':sessionId/:messageId/feedback')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: 'Submit anonymous feedback for an Agent message' })
  @ApiResponse({ status: 200, description: 'Anonymous feedback submitted.' })
  @ApiResponse({
    status: 400,
    description:
      'Feedback contains invalid data or the message is not a completed Agent response.',
  })
  @ApiResponse({ status: 404, description: 'Session or message not found.' })
  @ApiResponse({ status: 429, description: 'Feedback rate limit exceeded.' })
  @ApiResponse({ status: 503, description: 'Feedback delivery unavailable.' })
  async submitAnonymousMessageFeedback(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Param('messageId') messageId: string,
    @Body() dto: SubmitAnonymousMessageFeedbackDto,
  ) {
    const { did } = req.authData;
    return this.messagesService.submitAnonymousMessageFeedback({
      did,
      clientIp: req.ip,
      sessionId,
      messageId,
      submissionId: dto.submissionId,
      feedback: dto.feedback,
      context: dto.context,
    });
  }

  @Post(':sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a message to the oracle' })
  @ApiParam({
    name: 'sessionId',
    required: true,
    description: 'ID of the session to send a message to',
  })
  @ApiResponse({ status: 200, description: 'Message sent successfully.' })
  @ApiResponse({
    status: 400,
    description: 'Bad Request (e.g., missing/invalid parameters).',
  })
  async sendMessage(
    @Req() req: Request,
    @Body() sendMessageDto: SendMessageDto,
    @Param('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    const { did, userOpenIdToken, homeServer } = req.authData;

    // Build the payload
    const payload = {
      ...sendMessageDto,

      userMatrixOpenIdToken: userOpenIdToken,
      did,
      sessionId,
      homeServer,
    };

    // Handle streaming response if stream is true
    if (sendMessageDto.stream) {
      await this.messagesService.sendMessage({
        ...payload,
        res,
        req,
      });
      // The response is handled inside the service when streaming
    } else {
      // Regular response without streaming
      const result = await this.messagesService.sendMessage({
        ...payload,
        req,
      });
      return res.status(HttpStatus.OK).json(result);
    }
  }
}
