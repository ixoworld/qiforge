import { Module } from '@nestjs/common';
import { UserPreferencesController } from './user-preferences.controller.js';

/**
 * Plugin-owned HTTP surface. Returned from `UserPreferencesPlugin.getNestModules()`
 * so the `GET /user-preferences` endpoint only exists when the plugin is
 * loaded. Reads via `UserPreferencesService.getInstance()` — the same
 * singleton the plugin's middleware + tool consume, so the controller
 * shares state with the agent path.
 */
@Module({
  controllers: [UserPreferencesController],
})
export class UserPreferencesHttpModule {}
