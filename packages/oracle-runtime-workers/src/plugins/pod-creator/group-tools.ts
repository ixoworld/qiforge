/**
 * The governance group of a POD created in this conversation, as the Portal
 * provisions one (ixo-portal `lib/pods/provisionPodGroup.ts`), in two wallet
 * signatures:
 *
 * 1. `create_pod_group` — one `MsgInstantiateContract` of the network's
 *    DAO DAO `dao_core` (`buildDaoDaoGroupInstantiate`): a cw4 membership
 *    group, one vote per member, single-choice proposals passed by an
 *    absolute number of yes votes, a voting time and whether votes can be
 *    changed as the user chose (the Portal's 7 days and yes by default),
 *    the user's account as the contract's wasm admin. The transaction is read back by its hash (the
 *    wallet returns no events) for the group's core address.
 * 2. `link_pod_group` — `MsgAddLinkedEntity` (type group, relationship
 *    governs) and `MsgAddController did:ixo:wasm:<core>` on the POD
 *    (`buildDaoDaoGroupLinkMessages`), so the Portal's Decisions tab finds
 *    the group and the rooms bot admits its members.
 *
 * Two tools, one signature each: the link can be retried alone (its address
 * read again from the recorded transaction) when it failed, was declined,
 * or the group's transaction was not readable yet.
 *
 * Consent, as on the create path: the first `create_pod_group` call sends
 * nothing and answers the group exactly as it will be created (name, every
 * member, the threshold, the voting rules) and every risk of both signatures; the call that
 * signs must quote every risk, carry the same group, and come from a later
 * request than that preview — so the user saw the members in the chat
 * before the wallet asks. The wallet's own prompt, whose summary states the
 * same, is the human gate. The link needs no second confirmation in the
 * chat: it is the second half of what the user agreed, and the wallet shows
 * it. Members come from the user only; the tools never add one.
 */
import {
  DAODAO_DEFAULT_ALLOW_REVOTING,
  DAODAO_MAX_NAME_LENGTH,
  DAODAO_VOTING_PERIOD_SECONDS,
  RiskConfirmationSchema,
  buildBatchSignTransactionActionArgs,
  buildDaoDaoGroupInstantiate,
  buildDaoDaoGroupLinkMessages,
  describeValidationError,
  findMessageByRoute,
  riskTextKey,
  validateTransactionBatch,
  type ITrxMsg,
  type Network,
  type ValidatedTransactionBatch,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import { operationKey } from '../../core/middlewares/tool-execution';
import { ixoAddressOf } from '../../core/user-identity';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { TX_HASH_PATTERN } from '../ixo-chain/tx-lookup';
import {
  GROUP_VOTING_RULES_GUIDANCE,
  MAX_DAO_GROUP_MEMBERS,
  groupAllowRevotingField,
  groupMembersField,
  groupThresholdField,
  groupVotingPeriodField,
  membersText,
  passRuleText,
} from '../ixo-transaction/dao-group';
import {
  requestWalletSignature,
  walletUnavailableReason,
} from '../ixo-transaction/wallet-signing';
import {
  notConfiguredChainGateway,
  type ChainGateway,
  type PodGroupSpec,
} from './chain-gateway';
import { readPodCreatorConfig } from './config';
import type { CreateSessionStoreFor } from './create-session-store';
import { CHAIN_UNAVAILABLE_MESSAGE, SIGN_TIMEOUT_MS } from './create-tools';

const threadId = (ctx: RuntimeContext): string => ctx.session.id;

/** The most members a POD's group starts with (`MAX_DAO_GROUP_MEMBERS`). */
export const MAX_POD_GROUP_MEMBERS = MAX_DAO_GROUP_MEMBERS;

const createGroupSchema = z.object({
  members: groupMembersField(
    `The members' ixo1… account addresses, each with one vote, exactly as the user gave or confirmed them (at most ${MAX_POD_GROUP_MEMBERS}). Never invent or complete one; include the user's own account only when they want to be a member.`,
  ),
  threshold: groupThresholdField,
  name: z
    .string()
    .trim()
    .min(1)
    .max(DAODAO_MAX_NAME_LENGTH)
    .optional()
    .describe(
      `The group's public name (at most ${DAODAO_MAX_NAME_LENGTH} characters, one line). Default: the POD's name.`,
    ),
  votingPeriodSeconds: groupVotingPeriodField,
  allowRevoting: groupAllowRevotingField,
  riskConfirmation: RiskConfirmationSchema.optional().describe(
    'Leave out on the first call: it sends nothing and returns the group and its risks to show the user. In a later message, once the user confirmed, call again with the same members, threshold and name and every risk quoted exactly.',
  ),
});

const linkGroupSchema = z.object({
  txHash: z
    .string()
    .regex(TX_HASH_PATTERN, 'expected a 64-character hex transaction hash')
    .optional()
    .describe(
      "Only when create_pod_group said so: the group's transaction hash, from the user (the wallet returned none, or its answer was lost).",
    ),
});

/** What `create_pod_group` returns to the model. */
export type CreatePodGroupResult =
  | {
      /** Nothing was sent: the group to show the user, and every risk. */
      status: 'confirm';
      podDid: string;
      name: string;
      members: string[];
      threshold: number;
      votingPeriodSeconds: number;
      allowRevoting: boolean;
      summary: string;
      linkSummary: string;
      risks: string[];
      message: string;
    }
  | {
      status: 'created';
      podDid: string;
      name: string;
      txHash?: string;
      /** Absent while the transaction could not be read yet. */
      coreAddress?: string;
      message: string;
    }
  | { status: 'refused'; retryable: boolean; message: string }
  | {
      status: 'failed';
      code: number;
      txHash?: string;
      error: string;
      message: string;
    }
  | {
      status: 'rejected' | 'error' | 'unavailable';
      error: string;
      message: string;
    }
  | { status: 'timeout'; outcome: 'unknown'; error: string; message: string };

/** What `link_pod_group` returns to the model. */
export type LinkPodGroupResult =
  | {
      status: 'linked';
      podDid: string;
      coreAddress: string;
      txHash?: string;
      /** The POD's Decisions tab in the Portal. */
      decisionsUrl: string;
      message: string;
    }
  | {
      /** The group's transaction is not readable yet: call again later. */
      status: 'pending' | 'unavailable';
      retryable: boolean;
      message: string;
    }
  | { status: 'refused'; retryable: boolean; message: string }
  | {
      status: 'failed';
      code: number;
      txHash?: string;
      error: string;
      message: string;
    }
  | {
      status: 'rejected' | 'error' | 'unavailable';
      error: string;
      message: string;
    }
  | { status: 'timeout'; outcome: 'unknown'; error: string };

const refused = (message: string, retryable = false) => ({
  status: 'refused' as const,
  retryable,
  message,
});

const MAINNET_OFF =
  'Mainnet POD creation is disabled on this oracle (POD_CREATOR_ALLOW_MAINNET), so no governance group is created.';

const NO_POD =
  'No POD was confirmed in this conversation (confirm_pod_creation first), so there is no POD to give a governance group. A group is created here only for the POD this conversation created; for a POD made earlier or elsewhere, link an existing DAO DAO group with link_dao_group (IXO Transaction), or create one with create_dao_group first.';

/** The risks of the link pair, from the catalog, as the user accepts them with the group. */
function linkRisks(): string[] {
  return (['add-linked-entity', 'add-controller'] as const).flatMap(
    (action) => {
      const spec = findMessageByRoute('iid', action);
      if (!spec) throw new Error(`The catalog has no /ixo iid ${action}`);
      return spec.risks;
    },
  );
}

/** What the user approves for the group: its name, every member, the threshold and the voting rules. */
function groupSummary(
  network: Network,
  podDid: string,
  sender: string,
  group: PodGroupSpec,
): string {
  const you = group.members.includes(sender)
    ? `You (${sender}) are a member.`
    : `You (${sender}) are not a member.`;
  return `Create the governance group "${group.name}" of your POD ${podDid} on ${network}: ${membersText(group.members)}. ${passRuleText(group)} ${you} A second signature then links it to the POD.`;
}

/** What the link signs; before the group exists (`core` absent), what it will sign. */
function linkSummary(
  network: Network,
  podDid: string,
  name: string,
  core?: string,
): string {
  const group =
    core === undefined
      ? `the governance group "${name}"`
      : `the governance group "${name}" (${core})`;
  const controller = core === undefined ? '' : ` (did:ixo:wasm:${core})`;
  return `Link ${group} to your POD ${podDid} on ${network} as the group that governs it, and add the group as a controller of the POD${controller}: proposals the group passes can then update the POD, and its members can join the POD's rooms.`;
}

/**
 * The group creation as the wallet will see it, validated by the catalog
 * for the network; throws with the reason when the group is refused.
 */
function prepareGroup(
  network: Network,
  sender: string,
  podDid: string,
  group: PodGroupSpec,
  mainnetAllowed: boolean,
): ValidatedTransactionBatch {
  const message: ITrxMsg = buildDaoDaoGroupInstantiate(network, {
    sender,
    members: group.members,
    threshold: group.threshold,
    name: group.name,
    // The Portal creates a POD's group with an empty description.
    description: '',
    votingPeriodSeconds: group.votingPeriodSeconds,
    allowRevoting: group.allowRevoting,
  });
  return validateTransactionBatch(
    {
      network,
      summary: groupSummary(network, podDid, sender, group),
      messages: [message],
    },
    { allowMainnet: mainnetAllowed },
  );
}

/** The POD's governance group tools: `create_pod_group`, `link_pod_group`. */
export function createGroupTools(
  gateway: ChainGateway,
  sessionsFor: CreateSessionStoreFor,
): PluginTool[] {
  const chainUnavailable = gateway === notConfiguredChainGateway;

  const createGroup = tool(
    async (args, ctx): Promise<CreatePodGroupResult> => {
      const input = createGroupSchema.parse(args);
      if (chainUnavailable) return refused(CHAIN_UNAVAILABLE_MESSAGE);
      const { network, mainnetAllowed, chainIds } = readPodCreatorConfig(ctx);
      if (network === 'mainnet' && !mainnetAllowed) return refused(MAINNET_OFF);
      const sessions = sessionsFor(ctx);
      const session = await sessions.read(ctx.user.did, threadId(ctx));
      if (!session?.confirmed || !session.sent) return refused(NO_POD);
      const podDid = session.confirmed.podDid;
      if (session.group) {
        return refused(
          session.group.state === 'sending'
            ? 'The governance group of this POD was already sent to the wallet and its outcome is not known. Ask the user whether they signed it; if they did, call link_pod_group with its transaction hash. Do not send it again.'
            : `This POD's governance group was already created${session.group.coreAddress ? ` (${session.group.coreAddress})` : ''}; it is created once. ${session.group.link === 'linked' ? 'It is linked to the POD.' : 'Call link_pod_group to link it to the POD.'}`,
        );
      }
      const sender = ixoAddressOf(ctx.user.did);
      if (!sender)
        return refused(
          'Your identity is not an IXO account (did:ixo:ixo1…), so no group can be created from your wallet.',
        );
      const podName = session.sent.profile.name;
      if (input.name === undefined && podName.length > DAODAO_MAX_NAME_LENGTH)
        return refused(
          `The POD's name is longer than a group name may be (${DAODAO_MAX_NAME_LENGTH} characters): ask the user for a group name, on one line.`,
        );
      const group: PodGroupSpec = {
        name: input.name ?? podName,
        members: input.members,
        threshold: input.threshold,
        votingPeriodSeconds:
          input.votingPeriodSeconds ?? DAODAO_VOTING_PERIOD_SECONDS.default,
        allowRevoting: input.allowRevoting ?? DAODAO_DEFAULT_ALLOW_REVOTING,
      };
      let batch: ValidatedTransactionBatch;
      try {
        batch = prepareGroup(network, sender, podDid, group, mainnetAllowed);
      } catch (error) {
        return refused(
          `Nothing was sent: the group is refused (${describeValidationError(error)}). Tell the user what to change.`,
        );
      }
      const risks = [...batch.risks, ...linkRisks()];
      const digest = await operationKey('create_pod_group', {
        podDid,
        network,
        ...group,
      });
      const audit = `group of ${podDid} user=${ctx.user.did} thread=${threadId(ctx)}`;
      if (!input.riskConfirmation) {
        const previewed = await sessions.previewGroup(
          ctx.user.did,
          threadId(ctx),
          { digest, requestId: ctx.session.requestId },
        );
        if (previewed !== 'ok')
          return refused(
            previewed === 'no-pod'
              ? NO_POD
              : 'This POD’s governance group is already being created; it is created once.',
          );
        ctx.logger.log(`[pod-creator] group previewed ${audit}`);
        return {
          status: 'confirm',
          podDid,
          ...group,
          summary: batch.summary,
          linkSummary: linkSummary(network, podDid, group.name),
          risks,
          message:
            'Nothing was sent. Show the user this group exactly (its name, every member address, the threshold, how long voting lasts and whether votes can be changed) and every risk, word for word, and stop. Only when they confirm in a later message, call create_pod_group again with the same members, threshold, name, votingPeriodSeconds and allowRevoting and riskConfirmation quoting every risk. They then sign twice in their wallet: the group, then its link to the POD.',
        };
      }
      const accepted = new Set(
        input.riskConfirmation.acceptedRisks.map(riskTextKey),
      );
      const missing = risks.filter((risk) => !accepted.has(riskTextKey(risk)));
      if (!input.riskConfirmation.confirmed || missing.length > 0)
        return refused(
          `Nothing was sent: the user must accept every risk of the group, word for word, with confirmed: true. Missing: ${missing.map((risk) => JSON.stringify(risk)).join(', ') || '(confirmed is false)'}`,
        );
      // Nothing is claimed without a way to the wallet: the preview stays.
      const unavailable = walletUnavailableReason(ctx);
      if (unavailable !== null)
        return {
          status: 'unavailable',
          error: unavailable,
          message:
            'Nothing was sent: call create_pod_group again (with the same confirmation) once the user has the chat open in the Portal.',
        };
      const claim = await sessions.claimGroup(ctx.user.did, threadId(ctx), {
        digest,
        requestId: ctx.session.requestId,
        group,
      });
      switch (claim.status) {
        case 'no-pod':
          return refused(NO_POD);
        case 'not-previewed':
          return refused(
            'Nothing was sent: this group (these members, threshold, name and voting rules) was not shown to the user first. Call create_pod_group without riskConfirmation, show the user the group, and wait for their confirmation.',
          );
        case 'same-request':
          return refused(
            'Nothing was sent: the group was shown in this same turn. Wait for the user to confirm it in a new message, then call create_pod_group again.',
          );
        case 'claimed':
          return refused(
            'This POD’s governance group is already being created; it is created once.',
          );
        case 'ok':
          break;
      }
      const signArgs = buildBatchSignTransactionActionArgs(
        {
          network,
          summary: batch.summary,
          messages: batch.messages,
          riskConfirmation: { confirmed: true, acceptedRisks: batch.risks },
        },
        { allowMainnet: mainnetAllowed, chainIds },
      );
      const outcome = await requestWalletSignature(ctx, {
        args: signArgs,
        callIdPrefix: 'pod_group',
        timeoutMs: SIGN_TIMEOUT_MS,
      });
      const release = () =>
        sessions.settleGroup(ctx.user.did, threadId(ctx), 'released');
      const retry =
        'Nothing was signed. If the user still wants the group, call create_pod_group again without riskConfirmation and confirm it with them again.';
      switch (outcome.status) {
        case 'signed': {
          const { transactionHash: txHash } = outcome;
          await sessions.settleGroup(
            ctx.user.did,
            threadId(ctx),
            txHash !== undefined ? { txHash } : {},
          );
          ctx.logger.log(
            `[pod-creator] wallet signed ${audit} tx=${txHash ?? 'none'}`,
          );
          if (txHash === undefined)
            return {
              status: 'created',
              podDid,
              name: group.name,
              message:
                'The wallet reports the group signed but returned no transaction hash, so its address cannot be read. Ask the user for the transaction hash, then call link_pod_group with it.',
            };
          const found = await gateway.findPodGroup(
            { txHash, network, group },
            ctx,
          );
          if (found.status !== 'found') {
            ctx.logger.warn(
              `[pod-creator] group ${found.status} ${audit} tx=${txHash}: ${found.message}`,
            );
            return {
              status: 'created',
              podDid,
              name: group.name,
              txHash,
              message:
                found.status === 'failed'
                  ? `The wallet reports the group signed, but its transaction does not show it (${found.message}). Tell the user to check the transaction in their wallet; nothing is linked.`
                  : `The group was signed, but its address cannot be read yet (${found.message}). Tell the user, then call link_pod_group (it reads the transaction again) to link it to the POD.`,
            };
          }
          await sessions.recordGroupCore(ctx.user.did, threadId(ctx), {
            txHash,
            coreAddress: found.coreAddress,
          });
          ctx.logger.log(
            `[pod-creator] group ${found.coreAddress} created ${audit}`,
          );
          return {
            status: 'created',
            podDid,
            name: group.name,
            txHash,
            coreAddress: found.coreAddress,
            message:
              'The group exists. Tell the user, then call link_pod_group now: one more wallet signature links it to the POD as its governing group, so the Portal’s Decisions tab and the POD’s rooms use it.',
          };
        }
        case 'failed':
          await release();
          ctx.logger.warn(
            `[pod-creator] group failed on chain ${audit} code=${outcome.code}`,
          );
          return {
            status: 'failed',
            code: outcome.code,
            ...(outcome.transactionHash !== undefined
              ? { txHash: outcome.transactionHash }
              : {}),
            error: outcome.error,
            message:
              'The transaction failed on chain, so no group was created. Tell the user the code and error.',
          };
        case 'rejected':
        case 'error':
        case 'unavailable':
          await release();
          ctx.logger.warn(
            `[pod-creator] group ${outcome.status} ${audit}: ${outcome.error}`,
          );
          return {
            status: outcome.status,
            error: outcome.error,
            message: retry,
          };
        case 'timeout':
          ctx.logger.warn(`[pod-creator] group outcome unknown ${audit}`);
          return {
            ...outcome,
            message:
              'If the user says it went through, call link_pod_group with the transaction hash from their wallet.',
          };
      }
    },
    {
      name: 'create_pod_group',
      description: `After confirm_pod_creation: give the POD this conversation created a DAO DAO governance group (a multisig: each member one vote, a proposal passes with \`threshold\` yes votes), as the Portal's Decisions tab needs, signed in the user's Portal wallet. Only when the user wants one, with the members and threshold they gave or confirmed: never invent members. ${GROUP_VOTING_RULES_GUIDANCE} The first call sends nothing and returns the group and its risks to show; the call that signs, in a later message, quotes every risk and repeats the same choices. Then call link_pod_group. Once per POD. For an existing group, or a POD made earlier or elsewhere, use link_dao_group (IXO Transaction) instead.`,
      schema: createGroupSchema,
    },
  );

  const linkGroup = tool(
    async (args, ctx): Promise<LinkPodGroupResult> => {
      const input = linkGroupSchema.parse(args);
      if (chainUnavailable) return refused(CHAIN_UNAVAILABLE_MESSAGE);
      const { network, mainnetAllowed, chainIds, portalUrl } =
        readPodCreatorConfig(ctx);
      if (network === 'mainnet' && !mainnetAllowed) return refused(MAINNET_OFF);
      const sessions = sessionsFor(ctx);
      const session = await sessions.read(ctx.user.did, threadId(ctx));
      if (!session?.confirmed) return refused(NO_POD);
      const recorded = session.group;
      if (!recorded)
        return refused(
          'No governance group was created for this POD in this conversation: call create_pod_group first.',
        );
      const audit = `group link of ${session.confirmed.podDid} user=${ctx.user.did} thread=${threadId(ctx)}`;
      if (recorded.coreAddress === undefined) {
        const txHash = recorded.txHash ?? input.txHash;
        if (txHash === undefined)
          return refused(
            recorded.state === 'sending'
              ? 'The group was sent to the wallet and its outcome is not known. Ask the user whether they signed it; if they did, call link_pod_group with its transaction hash.'
              : 'The group was signed but its transaction hash is not known: ask the user for it, then call link_pod_group with it.',
          );
        const found = await gateway.findPodGroup(
          { txHash, network, group: recorded.group },
          ctx,
        );
        if (found.status === 'failed') {
          ctx.logger.warn(
            `[pod-creator] ${audit} tx=${txHash}: ${found.message}`,
          );
          return refused(found.message);
        }
        if (found.status !== 'found') return found;
        await sessions.recordGroupCore(ctx.user.did, threadId(ctx), {
          txHash,
          coreAddress: found.coreAddress,
        });
      }
      const unavailable = walletUnavailableReason(ctx);
      if (unavailable !== null)
        return refused(
          `Nothing was sent (${unavailable}). Call link_pod_group again once the user has the chat open in the Portal.`,
          true,
        );
      const sender = ixoAddressOf(ctx.user.did);
      if (!sender)
        return refused(
          'Your identity is not an IXO account (did:ixo:ixo1…), so the POD cannot be updated from your wallet.',
        );
      const claim = await sessions.claimGroupLink(ctx.user.did, threadId(ctx));
      switch (claim.status) {
        case 'no-pod':
          return refused(NO_POD);
        case 'no-group':
        case 'no-core':
          return refused(
            'The group’s address is not known yet: call link_pod_group again in a moment.',
            true,
          );
        case 'claimed':
          return refused(
            claim.state === 'linked'
              ? 'The governance group is already linked to this POD; it is linked once.'
              : 'The link was already sent to the wallet and its outcome is not known. Ask the user whether they signed it; do not send it again.',
          );
        case 'ok':
          break;
      }
      const { podDid, coreAddress } = claim;
      const release = () =>
        sessions.settleGroupLink(ctx.user.did, threadId(ctx), 'released');
      let signArgs: ReturnType<typeof buildBatchSignTransactionActionArgs>;
      try {
        const batch = validateTransactionBatch(
          {
            network,
            summary: linkSummary(
              network,
              podDid,
              claim.group.name,
              coreAddress,
            ),
            messages: buildDaoDaoGroupLinkMessages(podDid, coreAddress, sender),
          },
          { allowMainnet: mainnetAllowed },
        );
        // The user accepted these risks with the group (create_pod_group).
        signArgs = buildBatchSignTransactionActionArgs(
          {
            network,
            summary: batch.summary,
            messages: batch.messages,
            riskConfirmation: { confirmed: true, acceptedRisks: batch.risks },
          },
          { allowMainnet: mainnetAllowed, chainIds },
        );
      } catch (error) {
        await release();
        throw new Error(
          `The group link the wallet would sign is refused: ${describeValidationError(error)}`,
        );
      }
      const outcome = await requestWalletSignature(ctx, {
        args: signArgs,
        callIdPrefix: 'pod_group_link',
        timeoutMs: SIGN_TIMEOUT_MS,
      });
      switch (outcome.status) {
        case 'signed':
          await sessions.settleGroupLink(ctx.user.did, threadId(ctx), 'linked');
          ctx.logger.log(
            `[pod-creator] wallet signed ${audit} core=${coreAddress} tx=${outcome.transactionHash ?? 'none'}`,
          );
          return {
            status: 'linked',
            podDid,
            coreAddress,
            ...(outcome.transactionHash !== undefined
              ? { txHash: outcome.transactionHash }
              : {}),
            decisionsUrl: `${portalUrl}/domain/${podDid}/overview?tab=decisions`,
            message:
              'The group governs the POD now. Give the user the Decisions link: there its members see, propose and vote on the group’s proposals (in this chat too, through the IXO Transaction tools).',
          };
        case 'failed':
          await release();
          ctx.logger.warn(
            `[pod-creator] ${audit} failed on chain code=${outcome.code}`,
          );
          return {
            status: 'failed',
            code: outcome.code,
            ...(outcome.transactionHash !== undefined
              ? { txHash: outcome.transactionHash }
              : {}),
            error: outcome.error,
            message:
              'The transaction failed on chain, so the group is not linked (the group itself exists). Tell the user the code and error; link_pod_group can be called again.',
          };
        case 'rejected':
        case 'error':
        case 'unavailable':
          await release();
          ctx.logger.warn(
            `[pod-creator] ${audit} ${outcome.status}: ${outcome.error}`,
          );
          return {
            status: outcome.status,
            error: outcome.error,
            message:
              'Nothing was signed: the group exists but is not linked to the POD yet. If the user wants it linked, call link_pod_group again.',
          };
        case 'timeout':
          ctx.logger.warn(`[pod-creator] ${audit} outcome unknown`);
          return outcome;
      }
    },
    {
      name: 'link_pod_group',
      description:
        "After create_pod_group: link the POD's new governance group to the POD with one wallet signature (a `group` linked entity with relationship `governs`, and the group added as a controller of the POD), so the Portal's Decisions tab and the POD's rooms use it. Returns the group's address and the Decisions link. Can be called again alone when it failed, was declined or the group's transaction was not readable yet. Once per POD.",
      schema: linkGroupSchema,
    },
  );

  return [createGroup, linkGroup];
}
