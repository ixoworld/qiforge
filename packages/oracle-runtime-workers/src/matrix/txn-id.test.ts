import { describe, expect, it } from 'vitest';
import { matrixTxnId, MAX_TXN_ID_LENGTH } from './txn-id';

describe('matrixTxnId', () => {
  it('joins the prefix and parts with dashes, deterministically', () => {
    expect(matrixTxnId('replay', '$sess', 'req-1', 'u')).toBe(
      'replay-$sess-req-1-u',
    );
    expect(matrixTxnId('replay', '$sess', 'req-1', 'u')).toBe(
      matrixTxnId('replay', '$sess', 'req-1', 'u'),
    );
    expect(matrixTxnId('replay', '$sess', 'req-1', 'u')).not.toBe(
      matrixTxnId('replay', '$sess', 'req-1', 'o'),
    );
  });

  it('maps the base64 characters the homeserver refuses and drops the rest', () => {
    expect(matrixTxnId('r', '$a/b+c')).toBe('r-$a_b-c');
    expect(matrixTxnId('r', '$a b\tc\nd\x7fe')).toBe('r-$abcde');
    expect(matrixTxnId('r', 'é')).toBe('r-');
  });

  it('never exceeds the homeserver limit', () => {
    expect(matrixTxnId('r', 'x'.repeat(400)).length).toBe(MAX_TXN_ID_LENGTH);
  });
});
