import { DurableObject } from 'cloudflare:workers';
import { ActionInteractionStore } from './store';
import {
  ActionInteractionError,
  CheckClaimDispatchSchema,
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
  async dispatch(userDid: string, inputJson: string) {
    try {
      return JSON.stringify({
        ok: true,
        result: await this.store(userDid).checkClaimDispatch(
          CheckClaimDispatchSchema.parse(JSON.parse(inputJson)),
        ),
      });
    } catch (error) {
      if (error instanceof ActionInteractionError)
        return JSON.stringify({ ok: false, code: error.code });
      throw error;
    }
  }
  async list(userDid: string, sessionId: string) {
    return JSON.stringify(await this.store(userDid).list(sessionId));
  }
  async forget(userDid: string, sessionId: string) {
    let total = 0;
    for (let n = 1; n > 0; total += n)
      n = await this.store(userDid).forgetSession(sessionId);
    return total;
  }
  async prune(userDid: string) {
    return this.store(userDid).prune();
  }
  /** Every key the store wrote, so retention tests can prove what is gone. */
  async keys() {
    return Array.from((await this.ctx.storage.list()).keys());
  }
  async advance(ms: number) {
    this.now += ms;
  }
}
