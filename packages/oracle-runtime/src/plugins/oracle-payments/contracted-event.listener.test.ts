import { describe, expect, it, vi } from 'vitest';
import { ORACLE_CONTRACTED_EVENT_TYPE } from '../../matrix/oracle-component-event.js';
import { applyContractedCacheBust } from './contracted-event.listener.js';

function makeContractRecordStub() {
  return { invalidate: vi.fn() };
}

describe('applyContractedCacheBust', () => {
  it('invalidates the sender DID cache on an ixo.oracle.contracted event', () => {
    const contractRecord = makeContractRecordStub();
    const returned = applyContractedCacheBust(
      {
        type: ORACLE_CONTRACTED_EVENT_TYPE,
        sender: '@did-ixo-ixo1useraddr:ixo.world',
        content: { collectionId: '42' },
      },
      contractRecord,
    );

    expect(returned).toBe('did:ixo:ixo1useraddr');
    expect(contractRecord.invalidate).toHaveBeenCalledWith(
      'did:ixo:ixo1useraddr',
    );
  });

  it('ignores events of a different type', () => {
    const contractRecord = makeContractRecordStub();
    const returned = applyContractedCacheBust(
      { type: 'm.room.message', sender: '@did-ixo-ixo1useraddr:ixo.world' },
      contractRecord,
    );
    expect(returned).toBeNull();
    expect(contractRecord.invalidate).not.toHaveBeenCalled();
  });

  it('ignores a contracted event whose sender is not a user DID', () => {
    const contractRecord = makeContractRecordStub();
    const returned = applyContractedCacheBust(
      { type: ORACLE_CONTRACTED_EVENT_TYPE, sender: '@someone:ixo.world' },
      contractRecord,
    );
    expect(returned).toBeNull();
    expect(contractRecord.invalidate).not.toHaveBeenCalled();
  });

  it('ignores a contracted event with no sender', () => {
    const contractRecord = makeContractRecordStub();
    expect(
      applyContractedCacheBust(
        { type: ORACLE_CONTRACTED_EVENT_TYPE },
        contractRecord,
      ),
    ).toBeNull();
    expect(contractRecord.invalidate).not.toHaveBeenCalled();
  });

  it('ignores a non-object / unparseable event', () => {
    const contractRecord = makeContractRecordStub();
    expect(applyContractedCacheBust(null, contractRecord)).toBeNull();
    expect(applyContractedCacheBust('nope', contractRecord)).toBeNull();
    expect(contractRecord.invalidate).not.toHaveBeenCalled();
  });
});
