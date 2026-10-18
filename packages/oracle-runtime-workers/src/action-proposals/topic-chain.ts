import protobuf from 'protobufjs/minimal.js';
import { z } from 'zod';
import {
  QueryEntityRequest,
  QueryEntityResponse,
  QueryParamsRequest,
  QueryParamsResponse,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/entity/v1beta1/query.js';
import {
  QueryCollectionRequest,
  QueryCollectionResponse,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/claims/v1beta1/query.js';
import {
  QueryGrantsRequest,
  QueryGrantsResponse,
} from '@ixo/impactxclient-sdk/module/codegen/cosmos/authz/v1beta1/query.js';
import {
  QuerySmartContractStateRequest,
  QuerySmartContractStateResponse,
} from '@ixo/impactxclient-sdk/module/codegen/cosmwasm/wasm/v1/query.js';
import { IxoAddressSchema } from '@ixo/ixo-transaction/action-proposals';
import { boundedBytes } from '../core/domain-context/transport';
import { digestTopicProposalEffect } from './topic-store';
const encode64 = (v: Uint8Array) =>
  btoa(Array.from(v, (c) => String.fromCharCode(c)).join(''));
const decode64 = (v: string) =>
  Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
const hex = (v: Uint8Array) =>
  Array.from(v, (c) => c.toString(16).padStart(2, '0')).join('');
export class TopicChainReader {
  constructor(
    private readonly rpc: string,
    private readonly chainId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string) {
    const base = new URL(this.rpc);
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error('Invalid trusted RPC');
    const res = await this.fetcher(
      new URL(path, `${base.href.replace(/\/$/, '')}/`),
      { redirect: 'error', signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) throw new Error('Chain authority unavailable');
    return JSON.parse(
      new TextDecoder().decode(await boundedBytes(res, 524288)),
    ) as unknown;
  }
  async checkChain() {
    const s = z
      .object({
        result: z.object({ node_info: z.object({ network: z.string() }) }),
      })
      .parse(await this.request('status'));
    if (s.result.node_info.network !== this.chainId)
      throw new Error('Chain authority mismatch');
  }
  private async query(path: string, data: Uint8Array) {
    const r = z
      .object({
        result: z.object({
          response: z.object({
            code: z.number().optional(),
            value: z.string(),
            height: z.string(),
          }),
        }),
      })
      .parse(
        await this.request(
          `abci_query?path=${encodeURIComponent(JSON.stringify(path))}&data=0x${hex(data)}&prove=false`,
        ),
      ).result.response;
    if (r.code) throw new Error('Authoritative chain query failed');
    return decode64(r.value);
  }
  async collection(
    entityDid: string,
    collectionId: string,
    signerAddress: string,
  ) {
    await this.checkChain();
    const entity = QueryEntityResponse.decode(
      await this.query(
        '/ixo.entity.v1beta1.Query/Entity',
        QueryEntityRequest.encode(
          { id: entityDid },
          new protobuf.Writer(),
        ).finish(),
      ),
    ).entity;
    const collection = QueryCollectionResponse.decode(
      await this.query(
        '/ixo.claims.v1beta1.Query/Collection',
        QueryCollectionRequest.encode(
          { id: collectionId },
          new protobuf.Writer(),
        ).finish(),
      ),
    ).collection;
    const params = QueryParamsResponse.decode(
      await this.query(
        '/ixo.entity.v1beta1.Query/Params',
        QueryParamsRequest.encode({}, new protobuf.Writer()).finish(),
      ),
    ).params;
    const admin = entity?.accounts.find((a) => a.name === 'admin');
    if (
      !entity ||
      entity.id !== entityDid ||
      !collection ||
      collection.id !== collectionId ||
      collection.entity !== entityDid ||
      !admin ||
      collection.admin !== admin.address ||
      !params?.nftContractAddress
    )
      throw new Error('Entity collection and admin binding mismatch');
    IxoAddressSchema.parse(admin.address);
    const smart = QuerySmartContractStateRequest.fromPartial({
      address: params.nftContractAddress,
      queryData: new TextEncoder().encode(
        JSON.stringify({
          owner_of: { token_id: entityDid, include_expired: false },
        }),
      ),
    });
    const owner = QuerySmartContractStateResponse.decode(
      await this.query(
        '/cosmwasm.wasm.v1.Query/SmartContractState',
        QuerySmartContractStateRequest.encode(
          smart,
          new protobuf.Writer(),
        ).finish(),
      ),
    );
    const nft = z
      .object({ owner: IxoAddressSchema })
      .parse(JSON.parse(new TextDecoder().decode(owner.data)));
    if (nft.owner !== signerAddress)
      throw new Error('Signing account is not the entity NFT owner');
    return {
      adminAddress: admin.address,
      dependencies: [
        {
          kind: 'entity' as const,
          key: entityDid,
          digest: await digestTopicProposalEffect({
            id: entity.id,
            accounts: entity.accounts,
          }),
        },
        {
          kind: 'collection' as const,
          key: collectionId,
          digest: await digestTopicProposalEffect({
            id: collection.id,
            entity: collection.entity,
            admin: collection.admin,
          }),
        },
        {
          kind: 'nft-owner' as const,
          key: params.nftContractAddress,
          digest: await digestTopicProposalEffect({
            entityDid,
            owner: nft.owner,
          }),
        },
      ],
    };
  }
  async authorization(
    admin: string,
    grantee: string,
    role: 'submit' | 'evaluate',
  ) {
    const typeUrl =
      role === 'submit'
        ? ('/ixo.claims.v1beta1.SubmitClaimAuthorization' as const)
        : ('/ixo.claims.v1beta1.EvaluateClaimAuthorization' as const);
    const messageType =
      role === 'submit'
        ? '/ixo.claims.v1beta1.MsgSubmitClaim'
        : '/ixo.claims.v1beta1.MsgEvaluateClaim';
    const request = QueryGrantsRequest.fromPartial({
      granter: admin,
      grantee,
      msgTypeUrl: messageType,
    });
    const response = QueryGrantsResponse.decode(
      await this.query(
        '/cosmos.authz.v1beta1.Query/Grants',
        QueryGrantsRequest.encode(request, new protobuf.Writer()).finish(),
      ),
    );
    if (response.pagination?.nextKey.length || response.grants.length > 1)
      throw new Error('Authorization query exceeds exact single-grant bound');
    const grant = response.grants[0];
    if (grant?.authorization && grant.authorization.typeUrl !== typeUrl)
      throw new Error('Authorization role mismatch');
    return {
      existing: grant?.authorization
        ? { typeUrl, valueBase64: encode64(grant.authorization.value) }
        : undefined,
      dependency: {
        kind: 'authorization' as const,
        key: `${admin}\0${grantee}\0${role}`,
        digest: await digestTopicProposalEffect(
          grant
            ? {
                authorization: grant.authorization
                  ? {
                      typeUrl: grant.authorization.typeUrl,
                      valueBase64: encode64(grant.authorization.value),
                    }
                  : null,
                expiration: grant.expiration
                  ? {
                      seconds: grant.expiration.seconds.toString(),
                      nanos: grant.expiration.nanos,
                    }
                  : null,
              }
            : null,
        ),
      },
    };
  }
}
