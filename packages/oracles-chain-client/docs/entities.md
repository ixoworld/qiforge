# Entities

Class for managing IXO blockchain entities including creation, querying, and settings management.

## Quick Start

```typescript
import { Entities } from '@ixo/oracles-chain-client';

// Get entity by ID
const entity = await Entities.getEntityById('ixo:...');

// Get entities by owner
const entities = await Entities.getEntitiesByOwnerAddress('ixo1owner...');

// Get claim collection
const collection = await Entities.getClaimCollection('collection-456');
```

## Static Methods

### `getEntityById(entityId)`

Retrieves an entity by its unique identifier.

```typescript
const entity = await Entities.getEntityById('entity-123');
```

### `getEntitiesByOwnerAddress(ownerAddress)`

Gets all entities owned by a specific address.

```typescript
const entities = await Entities.getEntitiesByOwnerAddress('ixo1owner...');
```

### `getEntityIdByClaimCollectionId(claimCollectionId)`

Finds the entity associated with a claim collection.

```typescript
const entity = await Entities.getEntityIdByClaimCollectionId('collection-456');
```

### `getEntityByType(type)`

Retrieves entities filtered by type.

```typescript
const entities = await Entities.getEntityByType('oracle');
```

### `getClaimCollection(claimCollectionId)`

Gets claim collection details.

```typescript
const collection = await Entities.getClaimCollection('collection-456');
```

### `getSettingsResource(params, matrixAccessToken?, matrixHomeServer?)`

Fetches entity settings and configuration. The access token is sent only for media on `matrixHomeServer`, the caller's own homeserver; every other URL is fetched with no credential.

```typescript
const settings = await Entities.getSettingsResource({
  protocolDid: 'did:ixo:entity:...',
  id: '{id}#config',
});
```

## Instance Methods

### `create(value)`

Creates a new entity on the blockchain.

```typescript
const entities = new Entities(client);

// Encode message on client side
const messageValue = ixo.entity.v1beta1.MsgCreateEntity.fromPartial({...});
const entityBuffer = ixo.entity.v1beta1.MsgCreateEntity.encode(messageValue).finish();

// Send to server and create entity
const entityDid = await entities.create(entityBuffer);
```

### `getEntityIdFromTx(txHash)`

Extracts entity ID from a transaction hash.

```typescript
const entityId = await entities.getEntityIdFromTx('tx-hash-123');
```

## Usage Patterns

### Entity Creation Workflow

```typescript
// 1. Client side - encode message
const messageValue = ixo.entity.v1beta1.MsgCreateEntity.fromPartial({
  entityType: 'oracle',
  entityStatus: 1,
  // ... other fields
});
const buffer = ixo.entity.v1beta1.MsgCreateEntity.encode(messageValue).finish();

// 2. Send buffer to server
// 3. Server side - create entity
const entities = new Entities(walletClient);
const entityDid = await entities.create(buffer);
```

### Settings Management

```typescript
// Get oracle configuration
const oracleConfig = await Entities.getSettingsResource({
  protocolDid: 'did:ixo:entity:oracle123',
  id: '{id}#config',
});

// Get pricing information
const pricing = await Entities.getSettingsResource({
  protocolDid: 'did:ixo:entity:oracle123',
  id: '{id}#fee',
});
```
