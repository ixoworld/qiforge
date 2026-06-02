import { Ed25519, sha256 } from '@cosmjs/crypto';
import { toHex, toUtf8 } from '@cosmjs/encoding';
import { getResolver as IxoDidResolver } from '@ixo/did-provider-x';
import {
  type ICreateVerifiableCredentialArgs,
  type IDIDManager,
  type IDataStore,
  type IIdentifier,
  type IKeyManager,
  type IResolver,
  type MinimalImportableIdentifier,
  type MinimalImportableKey,
  type TAgent,
  type VerifiableCredential,
  createAgent,
} from '@veramo/core';
import {
  CredentialProviderLD,
  LdDefaultContexts,
  VeramoEd25519Signature2018,
  VeramoEd25519Signature2020,
} from '@veramo/credential-ld';
import {
  CredentialPlugin,
  type ICredentialIssuer,
} from '@veramo/credential-w3c';
import { DIDManager, MemoryDIDStore } from '@veramo/did-manager';
import { KeyDIDProvider } from '@veramo/did-provider-key';
import { DIDResolverPlugin } from '@veramo/did-resolver';
import {
  KeyManager,
  MemoryKeyStore,
  MemoryPrivateKeyStore,
} from '@veramo/key-manager';
import { KeyManagementSystem } from '@veramo/kms-local';
import { Resolver } from 'did-resolver';

// Resolver networks - using the same as the server
export const RESOLVER_NETWORKS = {
  devnet: 'https://resolver.devnet.ixo.earth/1.0/identifiers/',
  testnet: 'https://resolver.testnet.ixo.earth/1.0/identifiers/',
  mainnet: 'https://resolver.ixo.world/1.0/identifiers/',
};

interface CreateCredentialParams {
  credential: ICreateVerifiableCredentialArgs;
  mnemonic: string;
  issuerDid: string;
  agent: TAgent<
    IDIDManager & IKeyManager & IDataStore & IResolver & ICredentialIssuer
  >;
}

export async function createCredential({
  credential,
  mnemonic,
  issuerDid,
  agent,
}: CreateCredentialParams): Promise<VerifiableCredential> {
  if (!agent || !agent.createVerifiableCredential) {
    throw new Error('Agent not found');
  }
  // Load issuer identity from mnemonic
  const identifier = await loadIssuerDid(agent, mnemonic, issuerDid);

  // Set the issuer in the credential
  credential.credential.issuer = { id: identifier.did };

  // Create the verifiable credential
  const verifiableCredential: VerifiableCredential =
    await agent.createVerifiableCredential(credential);

  // Clean up extra JWT properties that Veramo may add
  const vcRecord = verifiableCredential as unknown as Record<string, unknown>;
  if ('vc' in vcRecord) delete vcRecord.vc;
  if ('sub' in vcRecord) delete vcRecord.sub;
  if ('iss' in vcRecord) delete vcRecord.iss;
  if ('nbf' in vcRecord) delete vcRecord.nbf;
  if ('exp' in vcRecord) delete vcRecord.exp;

  return verifiableCredential;
}

/**
 * Loads the issuer DID from the mnemonic and imports it into the agent
 * Ed25519
 */
export async function loadIssuerDid(
  agent: TAgent<
    IDIDManager & IKeyManager & IDataStore & IResolver & ICredentialIssuer
  >,
  mnemonic: string,
  issuerDid: string,
): Promise<IIdentifier> {
  if (!agent.keyManagerGetKeyManagementSystems) {
    throw new Error('Key management system not found');
  }
  const [kms] = await agent.keyManagerGetKeyManagementSystems();
  if (!kms) {
    throw new Error('No key management system available');
  }

  // Generate Ed25519 keypair from mnemonic (original working method)
  const keypair = await Ed25519.makeKeypair(
    sha256(toUtf8(mnemonic)).slice(0, 32),
  );

  const key: MinimalImportableKey = {
    kms,
    type: 'Ed25519',
    kid: toHex(keypair.pubkey),
    publicKeyHex: toHex(keypair.pubkey),
    privateKeyHex: toHex(keypair.privkey) + toHex(keypair.pubkey),
  };

  if (!agent.didManagerImport) {
    throw new Error('DID manager import not found');
  }
  const identifier: IIdentifier = await agent.didManagerImport({
    keys: [key],
    did: issuerDid,
    controllerKeyId: key.kid,
  } as MinimalImportableIdentifier);

  return identifier;
}

/**
 * Creates a Veramo agent with the necessary plugins for credential creation and verification
 */
export const createVeramoAgent = async (
  network: 'devnet' | 'testnet' | 'mainnet',
) => {
  return createAgent<
    IDIDManager & IKeyManager & IDataStore & IResolver & ICredentialIssuer
  >({
    plugins: [
      new KeyManager({
        store: new MemoryKeyStore(),
        kms: {
          local: new KeyManagementSystem(new MemoryPrivateKeyStore()),
        },
      }),
      new DIDManager({
        store: new MemoryDIDStore(),
        defaultProvider: 'did:x',
        providers: {
          'did:x': new KeyDIDProvider({
            defaultKms: 'local',
          }),
          'did:ixo': new KeyDIDProvider({
            defaultKms: 'local',
          }),
        },
      }),
      new DIDResolverPlugin({
        resolver: new Resolver({
          ...IxoDidResolver({
            url: RESOLVER_NETWORKS[network],
          }),
        }),
      }),
      new CredentialPlugin([
        new CredentialProviderLD({
          contextMaps: [LdDefaultContexts],
          suites: [
            new VeramoEd25519Signature2018(),
            new VeramoEd25519Signature2020(),
          ],
        }),
      ]),
    ],
  });
};
