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
import type { Request, Response } from 'express';
import { AbortRequestDto, SendMessageDto } from './dto/send-message.dto.js';
import { MessagesService } from './messages.service.js';

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
    const { did } = req.authData;
    return this.messagesService.listMessages({
      sessionId,
      did,
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
    const { did } = req.authData;

    const payload = {
      ...sendMessageDto,
      did,
      sessionId,
    };

    if (sendMessageDto.stream) {
      await this.messagesService.sendMessage({
        ...payload,
        res,
        req,
      });
      // Streaming response is handled inside the service.
    } else {
      const result = await this.messagesService.sendMessage({
        ...payload,
        req,
      });
      return res.status(HttpStatus.OK).json(result);
    }
  }
}
