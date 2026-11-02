# Payments

Class for managing oracle payment workflows including escrow, claims, and pricing.

## Quick Start

```typescript
import { Payments } from '@ixo/oracles-chain-client';

const payments = new Payments();

// Send payment to escrow
await payments.sendPaymentToEscrow({
  granteeAddress: 'ixo1oracle...',
  userClaimCollection: 'collection-456',
  amount: { amount: '1000000', denom: 'uixo' },
});

// Submit payment claim
await payments.submitPaymentClaim(params, 'claim-123');
```

## Core Methods

### `sendPaymentToEscrow(params)`

Initiates payment by sending funds to escrow using claim intent.

```typescript
await payments.sendPaymentToEscrow({
  granteeAddress: 'ixo1oracle...',
  userClaimCollection: 'collection-456',
  amount: { amount: '1000000', denom: 'uixo' },
});
```

### `submitPaymentClaim(params, claimId)`

Submits a claim against the user's collection for payment.

```typescript
await payments.submitPaymentClaim(
  {
    userAddress: 'ixo1user...',
    granteeAddress: 'ixo1oracle...',
    userClaimCollection: 'collection-456',
    amount: { amount: '1000000', denom: 'uixo' },
  },
  'claim-123',
);
```

### `payClaim(params)`

Evaluates and approves a claim for payment.

```typescript
await payments.payClaim({
  userAddress: 'ixo1user...',
  claimCollectionId: 'collection-456',
  adminAddress: 'ixo1admin...',
  claimId: 'claim-123',
  sign: signFunction,
});
```

### `checkForActiveIntent(params)`

Checks if there's an active payment intent for the oracle.

```typescript
const hasActiveIntent = await payments.checkForActiveIntent({
  userClaimCollection: 'collection-456',
  granteeAddress: 'ixo1oracle...',
});
```

### `getOutstandingPayments(params)`

Gets list of unpaid claims for an oracle.

```typescript
const claimIds = await payments.getOutstandingPayments({
  userAddress: 'ixo1user...',
  oracleAddress: 'ixo1oracle...',
  userClaimCollection: 'collection-456',
});
```

## Static Methods

### `getOraclePricingList(oracleDid, matrixAccessToken?, matrixHomeServer?)`

Retrieves oracle pricing information from settings.

```typescript
const pricing = await Payments.getOraclePricingList(
  'did:ixo:entity:oracle123',
  'matrix-token',
  'mx.ixo.earth',
);
```

## Payment Workflow

### 1. Initialize Payment

```typescript
// Check for existing intent
const hasIntent = await payments.checkForActiveIntent({
  userClaimCollection: 'collection-456',
  granteeAddress: 'ixo1oracle...',
});

if (!hasIntent) {
  // Send payment to escrow
  await payments.sendPaymentToEscrow({
    granteeAddress: 'ixo1oracle...',
    userClaimCollection: 'collection-456',
    amount: { amount: '1000000', denom: 'uixo' },
  });
}
```

### 2. Oracle Claims Payment

```typescript
// Oracle submits claim
await payments.submitPaymentClaim(
  {
    userAddress: 'ixo1user...',
    granteeAddress: 'ixo1oracle...',
    userClaimCollection: 'collection-456',
    amount: { amount: '1000000', denom: 'uixo' },
  },
  generatedClaimId,
);
```

### 3. User Approves Payment

```typescript
// User evaluates and pays claim
await payments.payClaim({
  userAddress: 'ixo1user...',
  claimCollectionId: 'collection-456',
  adminAddress: 'ixo1admin...',
  claimId: 'claim-123',
  sign: userSignFunction,
});
```

## Pricing Format

```typescript
type PricingListItem = {
  title: string; // Service name
  description: string; // Service description
  amount: string; // Price in base units
  denom: string; // Token denomination
};
```

## Message Types

- `/ixo.claims.v1beta1.MsgClaimIntent` - Payment intent
- `/ixo.claims.v1beta1.MsgSubmitClaim` - Claim submission
- `/ixo.claims.v1beta1.MsgEvaluateClaim` - Claim evaluation

## Notes

- Payment workflow requires proper authorization setup
- Claims use intent mechanism for escrow functionality
- Outstanding payments are claims without evaluations
- Pricing fetched from oracle settings resources
