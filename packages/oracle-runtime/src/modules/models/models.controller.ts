import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type ModelListing } from '../../llm/model-catalog.js';
import { ModelsService } from './models.service.js';

/**
 * Public catalog of models a user can pick for a chat, each with a coarse cost
 * tier (`$`/`$$`/`$$$`), a plain-language blurb, and the marked-up price they
 * pay. Deliberately unauthenticated (see `AUTH_EXCLUDED_ROUTES`) so a client
 * can render the picker before the user has an active subscription.
 */
@ApiTags('models')
@Controller('models')
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List the models a user can choose from, with cost tier, price and the default.',
  })
  @ApiResponse({
    status: 200,
    description: 'Available models and the id of the default model.',
  })
  async listModels(): Promise<ModelListing> {
    return this.modelsService.listModels();
  }
}
