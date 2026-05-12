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
import { sendSSEHeartbeat, setSSEHeaders } from './sse.utils.js';

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('abort')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abort an ongoing stream request' })
  @ApiResponse({ status: 200, description: 'Request aborted successfully.' })
  async abortRequest(@Body() abortRequestDto: AbortRequestDto) {
    const success = this.messagesService.abortRequest(
      abortRequestDto.sessionId,
    );
    return { success };
  }

  @Get(':sessionId')
  @ApiOperation({ summary: 'List messages in a session' })
  @ApiParam({ name: 'sessionId', required: true })
  @ApiResponse({ status: 200, description: 'Messages retrieved successfully.' })
  @ApiResponse({ status: 400, description: 'Bad Request.' })
  @ApiResponse({ status: 404, description: 'Room not found.' })
  async listMessages(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
  ) {
    const { did } = req.authData;
    return this.messagesService.listMessages({ sessionId, did });
  }

  @Post(':sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a message to the oracle' })
  @ApiParam({ name: 'sessionId', required: true })
  @ApiResponse({ status: 200, description: 'Message sent successfully.' })
  @ApiResponse({ status: 400, description: 'Bad Request.' })
  async sendMessage(
    @Req() req: Request,
    @Body() sendMessageDto: SendMessageDto,
    @Param('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    const { did, ucanDelegation } = req.authData;
    const payload = {
      ...sendMessageDto,
      did,
      sessionId,
      ucanDelegation,
    };

    if (sendMessageDto.stream) {
      // Open the SSE channel BEFORE the service's pre-flight runs (session
      // lookup, checkpoint sync, room resolution). The client sees the
      // connection accepted within ~1ms; the orchestrator emits the first
      // `Thinking...` event once the agent build starts. No headers/body
      // contention because nothing else writes to `res` until the runner
      // takes over.
      setSSEHeaders(res);
      res.flushHeaders();
      sendSSEHeartbeat(res);

      await this.messagesService.sendMessage({ ...payload, res, req });
      // The service ends the response in its `finally` — nothing to return.
      return;
    }

    const result = await this.messagesService.sendMessage({ ...payload, req });
    return res.status(HttpStatus.OK).json(result);
  }
}
