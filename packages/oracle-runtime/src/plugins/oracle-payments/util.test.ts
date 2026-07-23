import { describe, expect, it } from 'vitest';
import { MAINNET_USDC_IBC_DENOM } from './types.js';
import { priceToCoin } from './util.js';

describe('priceToCoin', () => {
  it('uses uixo off mainnet, scaled by 1e6', () => {
    expect(priceToCoin(20, 'devnet')).toEqual({
      denom: 'uixo',
      amount: 20_000_000,
    });
  });

  it('uses the USDC IBC denom on mainnet', () => {
    expect(priceToCoin(20, 'mainnet')).toEqual({
      denom: MAINNET_USDC_IBC_DENOM,
      amount: 20_000_000,
    });
  });
});
