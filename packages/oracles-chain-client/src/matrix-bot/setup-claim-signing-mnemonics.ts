import { customMessages, ixo, utils } from '@ixo/impactxclient-sdk';
import { type KeyTypes } from '@ixo/impactxclient-sdk/messages/iid';
import { Logger } from '@ixo/logger';
import base58 from 'bs58';
import { Client } from 'src/client/client.js';
import {
  createVeramoAgent,
  loadIssuerDid,
} from 'src/client/create-credentials.js';
import { gqlClient } from 'src/gql/index.js';
import { getMatrixHomeServerForDid } from './did-matrix-batcher.js';
// Encryption of secret material at rest lives in `secret-box.ts`, which has no
// dependencies beyond node:crypto so it can be reasoned about and tested on its
// own. Imported for use below, and re-exported because both names are part of
// this package's public surface and the CLI imports them from this path.
import { decrypt, encrypt } from './secret-box.js';

export {
  encrypt,
  decrypt,
  isLegacyCiphertext,
  isWeakPassword,
  rewrap,
  MIN_RECOMMENDED_PASSWORD_LENGTH,
} from './secret-box.js';

async function getEncryptedSigningMnemonic(
  userRoomId: string,
  accessToken: string,
  homeServerUrl: string,
) {
  try {
    Logger.debug(
      '🚀 ~ getEncryptedSigningMnemonic ~ homeServerUrl:',
      homeServerUrl,
    );
    const response = await fetch(
      `${homeServerUrl}/_matrix/client/v3/rooms/${userRoomId}/state/ixo.room.state.secure/encrypted_mnemonic_ed_signing`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(
        `Failed to get signing encrypted mnemonic: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as { encrypted_mnemonic: string };

    if (!data?.encrypted_mnemonic) {
      throw new Error('Failed to get signing encrypted mnemonic');
    }

    return data.encrypted_mnemonic;
  } catch (error) {
    Logger.error('Failed to get encrypted mnemonic:', error);
    throw error;
  }
}

async function storeEncryptedSigningMnemonic(
  userRoomId: string,
  accessToken: string,
  encryptedMnemonic: string,
  homeServerUrl: string,
) {
  try {
    const response = await fetch(
      `${homeServerUrl}/_matrix/client/v3/rooms/${userRoomId}/state/ixo.room.state.secure/encrypted_mnemonic_ed_signing`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ encrypted_mnemonic: encryptedMnemonic }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to store encrypted_mnemonic_ed_signing in matrix room: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { event_id: string };

    if (!data) {
      throw new Error(
        'Failed to store encrypted_mnemonic_ed_signing in matrix room: no event_id returned',
      );
    }

    return data.event_id;
  } catch (error) {
    Logger.error('Failed to store encrypted mnemonic:', error);
    throw error;
  }
}
export const checkIfVerificationMethodExists = (
  verificationMethods: Array<{ publicKeyBase58?: string }>,
  targetPublicKeyHex: string,
) => {
  return !!verificationMethods.find((method) => {
    if (!method.publicKeyBase58) return false;

    // Convert base58 public key back to hex for comparison
    const pubkeyBytes = base58.decode(method.publicKeyBase58);
    const pubkeyHex = Buffer.from(pubkeyBytes).toString('hex');

    return pubkeyHex === targetPublicKeyHex;
  });
};

export const generateVerificationMsg = async (
  relationships: string[] = ['authentication', 'assertionMethod'],
  walletDid: string,
  pubKey: string,
  walletAddress: string,
  keyType: KeyTypes = 'ed',
) => {
  const pubkeyBytes = new Uint8Array(Buffer.from(pubKey, 'hex'));

  return {
    typeUrl: '/ixo.iid.v1beta1.MsgAddVerification',
    value: ixo.iid.v1beta1.MsgAddVerification.fromPartial({
      id: walletDid,
      verification: ixo.iid.v1beta1.Verification.fromPartial({
        relationships,
        method: customMessages.iid.createVerificationMethod(
          walletDid,
          pubkeyBytes,
          walletDid,
          keyType,
        ),
      }),
      signer: walletAddress,
    }),
  };
};

interface SetupClaimSigningMnemonicsParams {
  matrixRoomId: string;
  matrixAccessToken: string;
  walletMnemonic: string;
  pin: string;
  signerDid: string;
  network: 'devnet' | 'testnet' | 'mainnet';
}

/**
 * Sets up encrypted claim signing mnemonics in Matrix room state
 * This function:
 * 1. Checks if encrypted mnemonic already exists in Matrix room state
 * 2. If not, encrypts the wallet mnemonic with the provided PIN and stores it
 * 3. Verifies the setup by creating a Veramo agent and loading the issuer DID
 */
export async function setupClaimSigningMnemonics({
  matrixRoomId,
  matrixAccessToken,
  walletMnemonic,
  pin,
  signerDid,
  network,
}: SetupClaimSigningMnemonicsParams): Promise<string> {
  const homeServerUrl = await getMatrixHomeServerForDid(signerDid);
  // Logger.info('Resolved homeserver for signer DID', { signerDid, homeServerUrl });

  let existingSigningMnemonic = await getEncryptedSigningMnemonic(
    matrixRoomId,
    matrixAccessToken,
    homeServerUrl,
  );

  if (!existingSigningMnemonic && walletMnemonic) {
    Logger.info('No existing signing mnemonic found, generating new one');
    const decryptedSigningMnemonic = utils.mnemonic.generateMnemonic();

    const encryptedSigningMnemonic = encrypt(decryptedSigningMnemonic, pin);

    await storeEncryptedSigningMnemonic(
      matrixRoomId,
      matrixAccessToken,
      encryptedSigningMnemonic,
      homeServerUrl,
    );

    Logger.info('Encrypted signing mnemonic stored in matrix room state');

    existingSigningMnemonic = await getEncryptedSigningMnemonic(
      matrixRoomId,
      matrixAccessToken,
      homeServerUrl,
    );

    Logger.info('Encrypted signing mnemonic retrieved from matrix room state');
  }

  if (!existingSigningMnemonic)
    throw new Error('Cannot get encrypted signing mnemonic');

  const agent = await createVeramoAgent(network);
  const decryptedSigningMnemonic = decrypt(existingSigningMnemonic, pin);
  const identifier = await loadIssuerDid(
    agent,
    decryptedSigningMnemonic,
    signerDid,
  );

  const { iids } = await gqlClient.GetIidVerificationMethod({ did: signerDid });

  if (!iids || iids.nodes.length === 0) {
    Logger.error('Cannot get UserDidDocVerificationMethod');
    throw new Error('Cannot get UserDidDocVerificationMethod');
  }

  const verificationMethods = iids?.nodes[0]?.verificationMethod;
  if (!verificationMethods) {
    Logger.error('Cannot get verification methods');
    throw new Error('Cannot get verification methods');
  }

  const publicKeyHex = identifier.keys[0]?.publicKeyHex;
  if (!publicKeyHex) {
    Logger.error('Cannot get public key hex');
    throw new Error('Cannot get public key hex');
  }
  if (!checkIfVerificationMethodExists(verificationMethods, publicKeyHex)) {
    const client = await Client.createCustomClient(walletMnemonic);
    Logger.info('Verification method does not exist, creating new one');
    const msgVerificationMethodCreation = await generateVerificationMsg(
      ['assertionMethod'],
      signerDid,
      publicKeyHex,
      client.address,
    );

    await client.signAndBroadcast([msgVerificationMethodCreation]);
    return decryptedSigningMnemonic;
  }

  return decryptedSigningMnemonic;
}
