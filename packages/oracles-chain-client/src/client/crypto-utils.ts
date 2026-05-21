import bs58 from 'bs58';
import { decrypt, encrypt } from 'eciesjs';
import type z from 'zod';

/**
 * Utility class for encrypting and decrypting data using ECIES with mnemonics
 * @param data - The data to encrypt
 * @param publicKeyBase58 - The public key to encrypt the data with
 * @returns The encrypted data
 * @example
 * const encryptedData = CryptoUtils.encrypt('Hello, world!', publicKeyBase58);
 * const decryptedData = CryptoUtils.decrypt(encryptedData, privateKeyHex);
 * const decryptedDataTyped = CryptoUtils.decryptTyped(encryptedData, privateKeyHex, zodSchema);
 */
export class CryptoUtils {
  /**
   * Encrypt the data with the public key hex
   * @param data - The data to encrypt
   * @param publicKeyBase58 - The public key to encrypt the data with
   * @returns The encrypted data
   */
  static encrypt(data: string, publicKeyBase58: string): string {
    try {
      // Browser-compatible buffer creation
      const dataBuffer =
        typeof Buffer !== 'undefined'
          ? Buffer.from(data)
          : new Uint8Array(new TextEncoder().encode(data));
      const publicKeyBytes = bs58.decode(publicKeyBase58);

      const encryptedBuffer = encrypt(publicKeyBytes, dataBuffer);
      return bs58.encode(encryptedBuffer); // Convert to bs58 string
    } catch (error) {
      // eslint-disable-next-line no-console -- browser-reachable file; @ixo/logger uses node:util and breaks webpack frontend builds (see package CLAUDE.md)
      console.error('Error encrypting data:', error);
      throw error;
    }
  }

  /**
   * Decrypt the encrypted data with the private key hex
   * @param encryptedData - The encrypted data
   * @param privateKey - The private key
   * @returns The decrypted data
   */
  static decrypt(encryptedData: string, privateKey: Uint8Array): string {
    try {
      const encryptedBuffer = bs58.decode(encryptedData);
      const decryptedBuffer = decrypt(privateKey, encryptedBuffer);

      // Browser-compatible string conversion
      if (typeof Buffer !== 'undefined') {
        return decryptedBuffer.toString();
      } else {
        return new TextDecoder().decode(decryptedBuffer);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error decrypting data:', error);
      throw error;
    }
  }

  /**
   * Decrypt the encrypted data with the private key hex and parse it with the zod schema
   * @param encryptedData - The encrypted data
   * @param privateKey - The private key
   * @param zodSchema - The zod schema to parse the data with
   * @returns The decrypted data
   */
  static decryptTyped<S extends z.ZodType>(
    encryptedData: string,
    privateKey: Uint8Array,
    zodSchema: S,
  ): z.infer<S> {
    const jsonParsableTypes: z.ZodType['def']['type'][] = [
      'object',
      'array',
      'record',
      'tuple',
    ];
    const isObject = jsonParsableTypes.includes(zodSchema.def.type);
    if (isObject) {
      return zodSchema.parse(
        JSON.parse(this.decrypt(encryptedData, privateKey)),
      );
    }
    return zodSchema.parse(this.decrypt(encryptedData, privateKey));
  }
}
