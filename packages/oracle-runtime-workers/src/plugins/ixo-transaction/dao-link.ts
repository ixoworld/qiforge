/**
 * `link_dao_group`: make an existing DAO DAO group the governing group of a
 * POD (or any other entity) the user can change, after the fact — a POD
 * created earlier, elsewhere or in the Portal, a group made with
 * `create_dao_group`. The POD Creator's `link_pod_group` does the same for
 * the POD of its own conversation only.
 *
 * The link is what the Portal writes when it provisions a POD's group
 * (`buildDaoDaoGroupLinkMessages`): `MsgAddLinkedEntity` (`{id}#<core>`,
 * type `group`, relationship `governs`) and `MsgAddController
 * did:ixo:wasm:<core>`, in one batch signed in the user's Portal wallet. The
 * group then has full control of the entity's identity, and its proposals
 * can change it.
 *
 * Before the preview and again before the wallet is asked, the entity and
 * the group are read on chain (`dao-link-check.ts`): the user's account must
 * be able to change the entity, the address must be a DAO DAO core, an
 * entity governed by another group is refused, and only the messages still
 * missing are sent (a retry after a partial link sends the rest). The
 * preview shows the group's name, members and pass rules, and notes for the
 * user: an entity type the Portal shows no Decisions tab for, a user who is
 * not a member of the group (allowed: a board need not include the POD's
 * owner, but they then have no say in what it decides).
 *
 * Consent and network, as every DAO DAO tool (`dao-tools.ts`): the first
 * call sends nothing and answers the summary and every risk; the signing
 * call quotes each risk and comes from a later request than a preview of the
 * same fields (`dao-confirmations.ts`). Each link is sent once per
 * conversation: recorded by the digest of its fields in the same record as
 * the groups `create_dao_group` sends, refused while it is being signed,
 * once linked, and after a lost answer until the chain shows it or the hold
 * ends. After the signature the transaction is read back (bounded) and the
 * link counts as made only when it is in a block with code 0.
 */
import {
  DaoDaoContractAddressSchema,
  buildBatchSignTransactionActionArgs,
  buildDaoDaoGroupLinkMessages,
  describeValidationError,
  validateTransactionBatch,
  type ITrxMsg,
  type Network,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import { operationKey } from '../../core/middlewares/tool-execution';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { TOOL_BUDGET_MS } from '../ixo-chain/http';
import { clip } from '../ixo-chain/summaries';
import { lookupTransaction, type Tx } from '../ixo-chain/tx-lookup';
import { portalUrlFor } from '../pod-creator/config';
import {
  GROUP_ATTEMPT_HOLD_MS,
  type GroupAttempt,
  type GroupSettlement,
} from './dao-confirmations';
import { checkGroupLink, type GroupLinkPlan } from './dao-link-check';
import { oracleChainCall } from './dao-proposal-check';
import {
  SIGNING_RULES,
  UNSIGNED_OUTCOMES,
  confirmationsOf,
  daoSigner,
  fittedSummary,
  logSigning,
  riskConfirmation,
  unconfirmedRefusal,
  unsignedResult,
  utc,
  type NotSignable,
  type UnsignedResult,
} from './dao-tools';
import type { IxoTransactionToolOptions } from './tools';
import {
  requestWalletSignature,
  walletUnavailableReason,
} from './wallet-signing';

const TOOL = 'link_dao_group';
const ADD_LINKED_ENTITY = '/ixo.iid.v1beta1.MsgAddLinkedEntity';
const ADD_CONTROLLER = '/ixo.iid.v1beta1.MsgAddController';
/** An IXO entity DID as the chain derives it. */
const ENTITY_DID = /^did:ixo:entity:[0-9a-f]{32}$/;
/** The most of a failed transaction's log passed on. */
const RAW_LOG_CHARS = 300;

/** What `link_dao_group` returns to the model. */
export type LinkDaoGroupResult =
  | {
      /** Nothing was sent: what will govern the entity, and every risk. */
      status: 'confirm';
      network: Network;
      entityDid: string;
      entityType: string;
      /** The entity's name, when the IXO Names worker knows it. */
      entityName?: string;
      coreAddress: string;
      groupName: string;
      /** Each member's address (and weight when it is not 1); absent when the group has no member list. */
      members?: string[];
      /** True when there may be more members than listed. */
      moreMembers?: true;
      /** How its proposals pass. */
      rules: string[];
      /** Whether the user is a member; absent when the members are not known. */
      youAreMember?: boolean;
      /** What the signature sends: the governing-group link, the controller, or both. */
      sends: Array<'governing-group link' | 'controller'>;
      /** For the user, before they agree. */
      notes: string[];
      summary: string;
      risks: string[];
      message: string;
    }
  | {
      /** Signed and read back: in a block, code 0, the link sent. */
      status: 'linked';
      network: Network;
      entityDid: string;
      coreAddress: string;
      txHash: string;
      /** The entity's Decisions tab in the Portal. */
      decisionsUrl: string;
      message: string;
    }
  | {
      /** The wallet reports it signed, but the transaction did not confirm the link (yet). */
      status: 'signed';
      network: Network;
      entityDid: string;
      coreAddress: string;
      txHash?: string;
      decisionsUrl: string;
      message: string;
    }
  | {
      /** Nothing was sent: the chain rules the link out, or it was not confirmed in a later request, or it was already sent. */
      status: 'refused';
      retryable: boolean;
      message: string;
    }
  | UnsignedResult
  | NotSignable;

const linkGroupSchema = z.strictObject({
  entityDid: z
    .string()
    .regex(ENTITY_DID, 'expected an entity DID: did:ixo:entity:<32 hex>')
    .describe(
      'The POD (or other entity) the group will govern: its did:ixo:entity:… DID, exactly as the user or chain_lookup gave it.',
    ),
  coreAddress: DaoDaoContractAddressSchema.describe(
    'The DAO DAO group: its core contract address (`dao` in chain_lookup daos, or the `coreAddress` create_dao_group returned), not one of its modules. Copy it exactly; never guess it.',
  ),
  riskConfirmation,
});

/** The entity as the summary names it: its name when known, its DID, its type. */
function entityNamed(plan: GroupLinkPlan): string {
  const { entity } = plan;
  return entity.name !== undefined
    ? `the ${entity.type} "${entity.name}" (${entity.did})`
    : `the ${entity.type} ${entity.did}`;
}

/**
 * What the user approves: the entity, the group and that it gets full
 * control of the entity's identity, for exactly the messages still missing.
 * The group's size and first pass rule are added when they fit the wallet's
 * summary (the preview lists every member and rule).
 */
function linkSummary(
  network: Network,
  sender: string,
  plan: GroupLinkPlan,
): string {
  const { group, missing } = plan;
  const core = group.coreAddress;
  const named = `the DAO DAO group "${group.name}" (${core})`;
  const entity = entityNamed(plan);
  const control = `the group gets full control of the entity’s identity, so proposals it passes can change anything about the entity`;
  const head =
    missing.linkedEntity && missing.controller
      ? `Link ${named} to ${entity} on ${network} as the group that governs it, and add the group as a controller of its identity (did:ixo:wasm:${core}): ${control}.`
      : missing.linkedEntity
        ? `Link ${named} to ${entity} on ${network} as the group that governs it. The group is already a controller of its identity (did:ixo:wasm:${core}), with full control of it.`
        : `Add ${named}, already linked as the group that governs ${entity} on ${network}, as a controller of its identity (did:ixo:wasm:${core}): ${control}.`;
  const from = ` Signed from your account ${sender}, which stays a controller too.`;
  const count = group.members?.length;
  const size =
    count === undefined
      ? ''
      : ` The group has ${count}${group.moreMembers ? ' or more' : ''} member${count === 1 ? '' : 's'}.`;
  const [rule] = group.rules;
  return fittedSummary(
    [
      `${head}${size}${rule !== undefined ? ` ${rule}` : ''}${from}`,
      `${head}${size}${from}`,
      `${head}${from}`,
    ],
    'The link’s summary does not fit the wallet’s summary.',
  );
}

/** The messages still missing, in the Portal's order: the link, then the controller. */
function missingMessages(
  plan: GroupLinkPlan,
  entityDid: string,
  coreAddress: string,
  sender: string,
): ITrxMsg[] {
  const [link, controller] = buildDaoDaoGroupLinkMessages(
    entityDid,
    coreAddress,
    sender,
  );
  return [
    ...(plan.missing.linkedEntity ? [link] : []),
    ...(plan.missing.controller ? [controller] : []),
  ];
}

const linkBodySchema = z.object({
  '@type': z.literal(ADD_LINKED_ENTITY),
  id: z.string(),
  linkedEntity: z.object({
    id: z.string(),
    type: z.string(),
    relationship: z.string(),
  }),
});

const controllerBodySchema = z.object({
  '@type': z.literal(ADD_CONTROLLER),
  id: z.string(),
  controller_did: z.string(),
});

/**
 * What the transaction says about the link sent: `linked` when it is in a
 * block with code 0 and carries each message sent (the same entity, the same
 * group); `failed` with its code and log; `other` when it does not carry
 * them.
 */
function linkOfTransaction(
  tx: Tx,
  sent: { entityDid: string; coreAddress: string; messages: ITrxMsg[] },
):
  | { status: 'linked' }
  | { status: 'failed'; code: number; height: string; error: string }
  | { status: 'other' } {
  const result = tx.tx_response;
  if (result.code !== 0)
    return {
      status: 'failed',
      code: result.code,
      height: result.height,
      error: `The transaction failed on chain (code ${result.code}${result.codespace ? ` in ${result.codespace}` : ''}): ${clip(result.raw_log, RAW_LOG_CHARS)}`,
    };
  const body = tx.tx.body.messages;
  const carries = (message: ITrxMsg) =>
    body.some((entry) => {
      if (message.typeUrl === ADD_LINKED_ENTITY) {
        const parsed = linkBodySchema.safeParse(entry);
        return (
          parsed.success &&
          parsed.data.id === sent.entityDid &&
          parsed.data.linkedEntity.id === `{id}#${sent.coreAddress}` &&
          parsed.data.linkedEntity.type === 'group' &&
          parsed.data.linkedEntity.relationship === 'governs'
        );
      }
      const parsed = controllerBodySchema.safeParse(entry);
      return (
        parsed.success &&
        parsed.data.id === sent.entityDid &&
        parsed.data.controller_did === `did:ixo:wasm:${sent.coreAddress}`
      );
    });
  return sent.messages.every(carries)
    ? { status: 'linked' }
    : { status: 'other' };
}

/**
 * The chain's refusals of the link that people run into (ixo-blockchain
 * `x/iid`), each as the chain words it and its plain reason.
 */
const LINK_REFUSALS: ReadonlyArray<{ words: RegExp; hint: string }> = [
  {
    // The ante handler's and the message server's signer checks.
    words:
      /not authorized to (?:act on behalf of the did|update the target did document)/i,
    hint: 'The chain changes an entity’s identity only for an account its identity document lists under authentication, and this wallet’s account is not one: someone who controls the entity has to link the group.',
  },
  {
    // `AddLinkedEntity`: the document already has a linked entity of that id.
    words: /duplicated linked entity id/i,
    hint: 'The entity already has this link: call link_dao_group again without riskConfirmation to see what is still missing.',
  },
  {
    words: /did document (?:at )?\S+ not found/i,
    hint: 'The chain has no identity document for that entity: check its DID.',
  },
];

/** The plain reason behind a refusal of the link, from the chain's words; undefined for any other error. */
export function linkHint(error: string): string | undefined {
  return LINK_REFUSALS.find(({ words }) => words.test(error))?.hint;
}

/**
 * Why this link is not sent again, by what became of the attempt that
 * blocks it; the chain was read first and does not show the link complete.
 */
function attemptedRefusal(attempt: GroupAttempt, entityDid: string): string {
  switch (attempt.state) {
    case 'created':
      return `Nothing was sent: this group was linked to ${entityDid} earlier in this conversation${attempt.txHash ? ` (transaction ${attempt.txHash})` : ''}, yet the entity no longer shows the whole link, so it was changed since. Tell the user what chain_lookup entity shows; linking it again is a new decision, made in a new conversation.`;
    case 'sending':
      return 'Nothing was sent: this link is being sent to the user’s wallet right now. Do not send it again; wait for that answer.';
    case 'unknown':
      return `Nothing was sent: this link was sent to the user’s wallet earlier in this conversation and its outcome is not known, and the entity does not show it yet. Do not send it again now: check with chain_lookup entity (its governingGroup, seconds behind), or call link_dao_group again later (it reads the entity). Only if the entity still does not show it may the link be shown and sent again, after ${utc(attempt.at + GROUP_ATTEMPT_HOLD_MS)}.`;
  }
}

const confirmMessage = (plan: GroupLinkPlan) =>
  `Nothing was sent. Show the user exactly what will govern their entity: the group’s name and address, every member${plan.group.members === undefined ? ' (not listed: see notes)' : ''} and whether they are one, how its proposals pass, every note and every risk, word for word, and stop. Only when they agree in a later message, call link_dao_group again with the same entityDid and coreAddress and riskConfirmation quoting each risk exactly.`;

const LINKED_MESSAGE =
  'The group governs the entity now: proposals it passes can change it. Give the user the Decisions link: there its members see, propose and vote on its proposals (in this chat too, with create_dao_proposal and vote_on_dao_proposal). chain_lookup entity shows it as governingGroup once indexed (seconds behind).';

async function linkDaoGroup(
  ctx: RuntimeContext,
  options: IxoTransactionToolOptions,
  args: unknown,
): Promise<LinkDaoGroupResult> {
  const signer = daoSigner(ctx, options, 'no group is linked here.');
  if (!('ok' in signer)) return signer;
  const confirmations = confirmationsOf(ctx);
  if (!('ok' in confirmations)) return confirmations;
  const { store } = confirmations;
  const { sender, network } = signer;
  const parsed = linkGroupSchema.safeParse(args);
  if (!parsed.success)
    return {
      status: 'validation_error',
      error: describeValidationError(parsed.error),
    };
  const { entityDid, coreAddress } = parsed.data;
  const confirmation = parsed.data.riskConfirmation;
  // The link as the user is shown it and as it is signed, and the key of
  // its one sending in this conversation.
  const digest = await operationKey(TOOL, {
    network,
    sender,
    entityDid,
    coreAddress,
  });
  const turn = { digest, requestId: ctx.session.requestId };
  const refused = (message: string, retryable = false) => ({
    status: 'refused' as const,
    retryable,
    message,
  });

  // Read before the preview, and again before the wallet is asked: the
  // entity or the group may have changed since.
  const plan = await checkGroupLink(ctx, {
    entityDid,
    coreAddress,
    sender,
    network,
  });
  if (!plan.ok) return refused(plan.message, plan.retryable);
  let batch: { network: Network; summary: string; messages: ITrxMsg[] };
  try {
    batch = {
      network,
      summary: linkSummary(network, sender, plan),
      messages: missingMessages(plan, entityDid, coreAddress, sender),
    };
  } catch (error) {
    return {
      status: 'validation_error',
      error: describeValidationError(error),
    };
  }
  const decisionsUrl = `${portalUrlFor(network, ctx.config)}/domain/${entityDid}/overview?tab=decisions`;

  if (!confirmation) {
    const attempt = await store.groupAttempt(
      ctx.user.did,
      ctx.session.id,
      digest,
    );
    if (attempt) return refused(attemptedRefusal(attempt, entityDid));
    let validated: ReturnType<typeof validateTransactionBatch>;
    try {
      validated = validateTransactionBatch(batch, {
        allowMainnet: options.allowMainnet,
      });
    } catch (error) {
      return {
        status: 'validation_error',
        error: describeValidationError(error),
      };
    }
    await store.preview(ctx.user.did, ctx.session.id, turn);
    const { group } = plan;
    return {
      status: 'confirm',
      network,
      entityDid,
      entityType: plan.entity.type,
      ...(plan.entity.name !== undefined
        ? { entityName: plan.entity.name }
        : {}),
      coreAddress,
      groupName: group.name,
      ...(group.members !== undefined
        ? {
            members: group.members.map((member) =>
              member.weight === 1
                ? member.addr
                : `${member.addr} (weight ${member.weight})`,
            ),
          }
        : {}),
      ...(group.moreMembers ? { moreMembers: true as const } : {}),
      rules: group.rules,
      ...(plan.userIsMember !== undefined
        ? { youAreMember: plan.userIsMember }
        : {}),
      sends: [
        ...(plan.missing.linkedEntity
          ? (['governing-group link'] as const)
          : []),
        ...(plan.missing.controller ? (['controller'] as const) : []),
      ],
      notes: plan.notes,
      summary: validated.summary,
      risks: validated.risks,
      message: confirmMessage(plan),
    };
  }

  let signArgs: ReturnType<typeof buildBatchSignTransactionActionArgs>;
  try {
    signArgs = buildBatchSignTransactionActionArgs(
      { ...batch, riskConfirmation: confirmation },
      { allowMainnet: options.allowMainnet, chainIds: options.chainIds },
    );
  } catch (error) {
    return {
      status: 'validation_error',
      error: describeValidationError(error),
    };
  }
  const unavailable = walletUnavailableReason(ctx);
  if (unavailable !== null)
    return { status: 'unavailable', error: unavailable };
  const claim = await store.claimGroup(ctx.user.did, ctx.session.id, turn);
  switch (claim.status) {
    case 'attempted':
      return refused(attemptedRefusal(claim.attempt, entityDid));
    case 'not-previewed':
    case 'same-request':
      return refused(unconfirmedRefusal(claim.status, TOOL));
    case 'ok':
      break;
  }
  const settle = (settlement: GroupSettlement) =>
    store.settleGroup(ctx.user.did, ctx.session.id, digest, settlement);
  const outcome = await requestWalletSignature(ctx, {
    args: signArgs,
    callIdPrefix: 'dao_link_group',
    timeoutMs: options.signTimeoutMs,
  });
  const audit = `user=${ctx.user.did} entity=${entityDid} core=${coreAddress}`;
  if (outcome.status !== 'signed') {
    // A timeout may still be signed: the same link stays blocked until the
    // chain shows it. Anything else changed nothing, so it can be sent again.
    await settle(
      outcome.status === 'timeout'
        ? { state: 'unknown' }
        : { state: 'released' },
    );
    const result = unsignedResult(
      outcome,
      network,
      signArgs.chainId,
      TOOL,
      linkHint,
    );
    logSigning(ctx, signArgs, result);
    return result;
  }
  const signed = {
    status: 'signed' as const,
    network,
    entityDid,
    coreAddress,
    decisionsUrl,
  };
  const txHash = outcome.transactionHash;
  let result: LinkDaoGroupResult;
  if (txHash === undefined) {
    await settle({ state: 'unknown' });
    result = {
      ...signed,
      message:
        'The wallet reports the link signed but returned no transaction hash, so it cannot be confirmed here. Do not send it again: chain_lookup entity shows the group as governingGroup once it is on chain (seconds behind), and link_dao_group (without riskConfirmation) reads the entity and says whether it is linked.',
    };
  } else {
    const found = await lookupTransaction(
      oracleChainCall(ctx, TOOL_BUDGET_MS),
      txHash,
      { label: 'dao group link transaction', tag: '[ixo-transaction]' },
    );
    const read =
      found.status === 'found'
        ? linkOfTransaction(found.tx, {
            entityDid,
            coreAddress,
            messages: batch.messages,
          })
        : undefined;
    if (read?.status === 'linked') {
      await settle({ state: 'created', txHash, coreAddress });
      ctx.logger.log(
        `[ixo-transaction] dao group linked ${audit} tx=${txHash}`,
      );
      result = {
        status: 'linked',
        network,
        entityDid,
        coreAddress,
        txHash,
        decisionsUrl,
        message: LINKED_MESSAGE,
      };
    } else if (read?.status === 'failed') {
      // In a block, but failed: nothing changed, so it can be sent again.
      await settle({ state: 'released' });
      const hint = linkHint(read.error);
      result = {
        status: 'failed',
        network,
        chainId: signArgs.chainId,
        code: read.code,
        transactionHash: txHash,
        height: read.height,
        error: read.error,
        ...(hint ? { hint } : {}),
        message:
          'The transaction was included in a block but failed (the chain’s reason is in `error`, with a `hint` when it is a common refusal), so nothing changed; only the network fee was paid. Tell the user why, in plain words.',
      };
    } else {
      await settle({ state: 'unknown' });
      const why =
        found.status === 'found'
          ? 'its transaction does not carry the link this conversation sent'
          : `its transaction could not be read yet (${found.message})`;
      ctx.logger.warn(
        `[ixo-transaction] dao group link unconfirmed ${audit} tx=${txHash}: ${why}`,
      );
      result = {
        ...signed,
        txHash,
        message: `The wallet reports the link signed, but ${why}. Do not send it again: chain_lookup entity shows the group as governingGroup once it is on chain (seconds behind), and link_dao_group (without riskConfirmation) reads the entity and says whether it is linked.`,
      };
    }
  }
  logSigning(ctx, signArgs, result);
  return result;
}

/** `link_dao_group` (a write): an existing DAO DAO group governs an existing entity. */
export function linkDaoGroupTool(
  options: IxoTransactionToolOptions,
): PluginTool {
  return tool((args, ctx) => linkDaoGroup(ctx, options, args), {
    name: TOOL,
    description: `Link an existing DAO DAO group to a POD or other entity the user can change, so the group governs it and the Portal's Decisions tab shows its proposals: a \`group\` linked entity with relationship \`governs\`, and the group added as a controller of the entity's identity (full control), in one wallet signature. For a POD made earlier, elsewhere or in the Portal, and after create_dao_group ("make my POD a DAO": create the group, then link it); for the POD created in this conversation use create_pod_group then link_pod_group instead. Only when the user asks for it, with the entity and group they named. Both calls read the entity and the group on chain first: the user's account must be able to change the entity, the address must be a DAO DAO group, and an entity this group already governs, or another group governs, is refused; only what is still missing is sent. The preview has the group's name, members, pass rules and \`notes\`: tell the user all of them. ${SIGNING_RULES} Each link is sent once per conversation. Returns linked (confirmed on chain, with \`decisionsUrl\`), signed (the wallet signed but the chain did not confirm it yet: do not send it again), refused (nothing sent: tell the user its \`message\`), ${UNSIGNED_OUTCOMES}.`,
    schema: linkGroupSchema,
  });
}
