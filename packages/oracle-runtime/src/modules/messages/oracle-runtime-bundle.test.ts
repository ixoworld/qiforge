import { beforeEach, describe, expect, it } from 'vitest';
import {
  OracleRuntimeBundleHolder,
  type OracleRuntimeBundle,
} from './oracle-runtime-bundle.js';

function makeBundle(): OracleRuntimeBundle {
  return {} as unknown as OracleRuntimeBundle;
}

describe('OracleRuntimeBundleHolder', () => {
  let holder: OracleRuntimeBundleHolder;

  beforeEach(() => {
    holder = new OracleRuntimeBundleHolder();
  });

  it('get() throws when populate has never been called', () => {
    expect(() => holder.get()).toThrow(/before populate/);
    expect(() => holder.get()).toThrow(/createOracleApp must run first/);
  });

  it('populate() called twice throws to enforce single-shot semantics', () => {
    holder.populate(makeBundle());
    expect(() => holder.populate(makeBundle())).toThrow(/single-shot/);
  });

  it('isReady() reflects populated state', () => {
    expect(holder.isReady()).toBe(false);
    holder.populate(makeBundle());
    expect(holder.isReady()).toBe(true);
  });
});
