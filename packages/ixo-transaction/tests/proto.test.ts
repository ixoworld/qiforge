import { describe, expect, it } from 'vitest';

import { resolveProtoCodec, toEncodeObject } from '../src/react/proto.js';
import { ADDRESS, DID, DID_2, ENTITY_DID } from './fixtures.js';

describe('proto fromJSON conversion (BE proto-JSON -> wallet EncodeObject)', () => {
  it('resolves a generated codec for an ixo Msg typeUrl', () => {
    const codec = resolveProtoCodec('/ixo.entity.v1beta1.MsgTransferEntity');
    expect(typeof codec.fromJSON).toBe('function');
  });

  it('keeps the typeUrl and converts a plain message', () => {
    const enc = toEncodeObject({
      typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity',
      value: {
        id: ENTITY_DID,
        ownerDid: DID,
        ownerAddress: ADDRESS,
        recipientDid: DID_2,
      },
    });
    expect(enc.typeUrl).toBe('/ixo.entity.v1beta1.MsgTransferEntity');
    expect(enc.value).toMatchObject({ id: ENTITY_DID, recipientDid: DID_2 });
  });

  it('decodes a base64 bytes field into a Uint8Array (the lossy case)', () => {
    const enc = toEncodeObject({
      typeUrl: '/ixo.smartaccount.v1beta1.MsgAddAuthenticator',
      value: {
        sender: ADDRESS,
        authenticatorType: 'SignatureVerification',
        // base64 of [1, 2, 3]
        data: 'AQID',
      },
    });
    expect(enc.value).toMatchObject({
      sender: ADDRESS,
      data: expect.any(Uint8Array),
    });
  });

  it('rejects a non-ixo namespace', () => {
    expect(() => resolveProtoCodec('/cosmos.bank.v1beta1.MsgSend')).toThrow(
      /namespace/,
    );
  });

  it('rejects an unknown ixo Msg', () => {
    expect(() => resolveProtoCodec('/ixo.entity.v1beta1.MsgNotReal')).toThrow(
      /codec/,
    );
  });
});
