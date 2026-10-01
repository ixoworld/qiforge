import { describe, expect, it } from 'vitest';
import { decideBootDirty } from './boot-dirty';

describe('decideBootDirty', () => {
  const base = {
    dirtyInMemory: false,
    dirtyFlag: undefined,
    uploadedGen: 7,
    writeGeneration: 7,
  };

  it('is clean when the last upload matches the file', () => {
    expect(decideBootDirty(base)).toBe('clean');
  });
  it('marks a working copy that moved past its last upload without a mark', () => {
    expect(decideBootDirty({ ...base, writeGeneration: 9 })).toBe(
      'behind-upload',
    );
  });
  it('adopts the persisted flag before looking at generations', () => {
    expect(
      decideBootDirty({ ...base, dirtyFlag: true, writeGeneration: 9 }),
    ).toBe('flagged');
    expect(decideBootDirty({ ...base, dirtyFlag: true })).toBe('flagged');
  });
  it('leaves a never-uploaded copy to the first completed turn', () => {
    expect(
      decideBootDirty({ ...base, uploadedGen: undefined, writeGeneration: 3 }),
    ).toBe('never-uploaded');
    expect(
      decideBootDirty({ ...base, uploadedGen: 'junk', writeGeneration: 3 }),
    ).toBe('never-uploaded');
  });
  it('does nothing when the object already knows', () => {
    expect(
      decideBootDirty({ ...base, dirtyInMemory: true, writeGeneration: 9 }),
    ).toBe('already-dirty');
  });
});
