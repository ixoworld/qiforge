import { DurableObject } from 'cloudflare:workers';
import { ActionInteractionStore } from './store';
import {
  ActionInteractionError,
  PrepareInteractionSchema,
  UpdateInteractionSchema,
  ReserveInteractionSchema,
  ObserveInteractionSchema,
} from '@ixo/action-interactions';
import { z } from 'zod';
const CommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepare'), input: PrepareInteractionSchema }),
  z.object({
    kind: z.literal('update'),
    id: z.string(),
    input: UpdateInteractionSchema,
  }),
  z.object({
    kind: z.literal('reserve'),
    id: z.string(),
    input: ReserveInteractionSchema,
  }),
  z.object({
    kind: z.literal('observe'),
    id: z.string(),
    input: ObserveInteractionSchema,
  }),
]);

/** Exercises the production store against real Durable Object transactions. */
export class ActionInteractionsTestDO extends DurableObject {
  private now = Date.now();
  private store(userDid: string) {
    return new ActionInteractionStore(
      this.ctx.storage,
      { userDid, oracleDid: 'did:ixo:oracle' },
      () => this.now,
    );
  }
  async command(userDid: string, inputJson: string) {
    try {
      return JSON.stringify({
        ok: true,
        result: await this.store(userDid).command(
          CommandSchema.parse(JSON.parse(inputJson)),
        ),
      });
    } catch (error) {
      if (error instanceof ActionInteractionError)
        return JSON.stringify({ ok: false, code: error.code });
      throw error;
    }
  }
  async read(userDid: string, id: string, sessionId: string) {
    try {
      return JSON.stringify({
        ok: true,
        result: await this.store(userDid).read(id, sessionId),
      });
    } catch (error) {
      if (error instanceof ActionInteractionError)
        return JSON.stringify({ ok: false, code: error.code });
      throw error;
    }
  }
  async advance(ms: number) {
    this.now += ms;
  }
}
