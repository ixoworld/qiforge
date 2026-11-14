import { HumanMessage } from '@langchain/core/messages';
import { vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  ChainBroadcastResult,
  ChainMessage,
  ChainSigningSurface,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import { oraclePaymentsConfigSchema, resolvePaymentsEnv } from './config';

export const ORACLE = 'ixo1oracle0000000000000000000000000000000';
export const BUYER = 'ixo1buyer00000000000000000000000000000000';
export const OTHER = 'ixo1other00000000000000000000000000000000';
export const ADMIN = 'ixo1admin00000000000000000000000000000000';
export const COLLECTION = '794';
export const DEED = 'did:ixo:entity:deed794';

export const CARD = {
  name: 'Verde MRV Studio',
  description: 'MRV plans for impact projects',
  services: [
    {
      id: 'mrv-plan',
      name: 'MRV plan design',
      priceUsd: 2000,
      doneMeans: ['Indicator set', 'Data-collection schedule'],
      deliveryTime: 'P3D',
    },
  ],
};

/** `ctx.config` as the runtime hands it: base keys plus this plugin's schema, validated. */
export function validatedConfig(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const raw = {
    NETWORK: 'devnet',
    AGENT_CARD_JSON: JSON.stringify(CARD),
    ...over,
  };
  return { ...raw, ...oraclePaymentsConfigSchema.parse(raw) };
}

export const PAYMENTS_ENV = resolvePaymentsEnv(validatedConfig());

export interface DevnetState {
  /** The grantee's SubmitClaimAuthorization constraints. */
  grants: Array<{
    collection_id: string;
    agent_quota: string;
    max_amount: Array<{ denom: string; amount: string }>;
    intent_duration_ns: string;
  }>;
  /** Users the deed links as subscribers. */
  linkedUsers: string[];
  /** The agreement doc decision-engine returns, or null for 404. */
  agreement: object | null;
  /** Bodies saved through the claim bot's `save-claim`. */
  savedClaims: unknown[];
  uploads: number;
  /** Per upload: the declared `size` field and the file's real byte length. */
  uploadSizes: Array<{ declared: string | null; actual: number }>;
}

type Grant = DevnetState['grants'][number];

/** One SubmitClaimAuthorization constraint on the buyer's collection. */
export function grant(over: Partial<Grant> = {}): Grant {
  return {
    collection_id: COLLECTION,
    agent_quota: '10',
    max_amount: [{ denom: 'upay', amount: '5000000000' }],
    intent_duration_ns: '2592000s',
    ...over,
  };
}

export function devnetState(over: Partial<DevnetState> = {}): DevnetState {
  return {
    grants: [grant()],
    linkedUsers: [BUYER],
    agreement: {
      kind: 'agent-services/v1',
      services: [
        {
          id: 'mrv-plan',
          name: 'MRV plan design',
          priceUsd: 2000,
          doneMeans: [],
        },
      ],
    },
    savedClaims: [],
    uploads: 0,
    uploadSizes: [],
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A `fetch` that answers like devnet's REST, Blocksync, decision-engine and claim bot. */
export function stubDevnetFetch(state: DevnetState): void {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/cosmos/authz/v1beta1/grants/grantee/')) {
        return json({
          grants: [
            {
              granter: ADMIN,
              authorization: {
                '@type': '/ixo.claims.v1beta1.SubmitClaimAuthorization',
                admin: ADMIN,
                constraints: state.grants,
              },
            },
          ],
          pagination: { next_key: null },
        });
      }
      if (url.includes('blocksync')) {
        const body = String(init?.body ?? '');
        if (body.includes('claimCollection')) {
          return json({
            data: {
              claimCollection: {
                id: COLLECTION,
                admin: ADMIN,
                entity: DEED,
                protocol: 'did:ixo:entity:agentwork',
                intents: 0,
              },
            },
          });
        }
        return json({
          data: {
            entity: {
              id: DEED,
              owner: 'ixo1service000000000000000000000000000000',
              linkedEntity: state.linkedUsers.map((a) => ({
                id: `{id}#${a}`,
                type: 'user',
                relationship: 'subscriber',
              })),
              service: [
                {
                  type: 'MatrixHomeServer',
                  serviceEndpoint: 'https://devmx.ixo.earth',
                },
              ],
            },
          },
        });
      }
      if (url.includes('/agreements')) {
        return state.agreement
          ? json({
              id: 'a1',
              digest: 'd1',
              counterparty: ORACLE,
              doc: state.agreement,
              capturedAt: '2026-10-19T00:00:00Z',
            })
          : json({ error: { code: 'NOT_FOUND' } }, 404);
      }
      if (url.endsWith('/media/upload')) {
        state.uploads += 1;
        const form = init?.body;
        if (form instanceof FormData) {
          const file = form.get('file');
          const declared = form.get('size');
          state.uploadSizes.push({
            declared: typeof declared === 'string' ? declared : null,
            actual: file instanceof Blob ? file.size : -1,
          });
        }
        return json({ data: { cid: `bafkmedia${state.uploads}` } });
      }
      if (url.endsWith('/action')) {
        const payload: { flags: { data: string } } = JSON.parse(
          String(init?.body),
        );
        state.savedClaims.push(JSON.parse(payload.flags.data));
        return json({ data: { cid: `bafkclaim${state.savedClaims.length}` } });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );
}

export interface RecordingChain extends ChainSigningSurface {
  sent: Array<{ messages: readonly ChainMessage[]; memo: string }>;
  /** Results to return in order; defaults to success. */
  queue: Array<ChainBroadcastResult | Error>;
}

export function recordingChain(): RecordingChain {
  const sent: RecordingChain['sent'] = [];
  const queue: RecordingChain['queue'] = [];
  return {
    sent,
    queue,
    address: async () => ORACLE,
    signAndBroadcast: async (messages, memo) => {
      sent.push({ messages, memo });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return (
        next ?? { code: 0, transactionHash: `TX${sent.length}`, gasUsed: 100n }
      );
    },
  };
}

const signedUcan: Pick<RuntimeContext['ucan'], 'mintSelfSignedInvocation'> = {
  mintSelfSignedInvocation: async () => ({ invocation: 'ucan-token' }),
};

/** A buyer's turn with `ctx.chain`, `ctx.kv` and a self-signing UCAN adapter. */
export function buyerCtx(
  opts: {
    chain?: ChainSigningSurface;
    kv?: UserKvSurface;
    userText?: string;
    config?: Record<string, unknown>;
  } = {},
): RuntimeContext {
  const base = makeRuntimeContext(
    {},
    {
      ambient: {
        kv: opts.kv ?? createMemoryUserKv(),
        ...(opts.chain ? { chain: opts.chain } : {}),
        config: validatedConfig(opts.config),
      },
      state: {
        messages: [
          new HumanMessage(
            opts.userText ??
              'Please design the MRV plan for my mangrove project.',
          ),
        ],
      },
    },
  );
  return {
    ...base,
    user: { ...base.user, did: `did:ixo:${BUYER}` },
    ucan: { ...base.ucan, ...signedUcan },
  };
}
