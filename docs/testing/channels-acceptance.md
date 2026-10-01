# Channels acceptance harness

Run `pnpm --filter qiforge-workers-example test:e2e:channels --help` for the command. The script reuses `test/lib/harness.ts` for real UCAN requests and `test/lib/matrix-client.ts` for a real encrypted Matrix device.

The harness sends messages and revokes its test binding. Use a dedicated, approved test number and set `CHANNEL_E2E_ALLOW_WRITES=1`. It will not run through a noninteractive CI session because WorkOS consent and Qi.Space verification are operator checkpoints. `--check-config` makes no network request.

Provide these environment variables through the existing secure harness environment. Do not commit them.

| Variable                                                                          | Value                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_GATEWAY_URL`                                                             | Gateway containing the Channels implementation.                                                                           |
| `AUTH_HUB_URL`, `AUTH_HUB_DID`                                                    | Auth Hub API origin and service DID.                                                                                      |
| `ORACLE_URL`, `ORACLE_DID`                                                        | The existing Companion oracle origin and DID.                                                                             |
| `MATRIX_TEST_BASE_URL`                                                            | Actual test homeserver HTTPS URL, or the local harness URL.                                                               |
| `CHANNEL_E2E_ORACLE_MATRIX_USER_ID`                                               | Trusted Matrix sender used by the oracle mirror.                                                                          |
| `CHANNEL_E2E_SUBJECT`                                                             | Never-seen WhatsApp subject controlled by the operator.                                                                   |
| `CHANNEL_SERVICE_AUTH_TOKEN`, `CHANNEL_STATUS_TOKEN`, `CHANNEL_SUBJECT_HMAC_KEY`  | Dedicated test gateway/Auth Hub configuration.                                                                            |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_PHONE_NUMBER_ID` | Approved test provider configuration.                                                                                     |
| `ACCOUNT_JSON`                                                                    | Secure path to the canonical account export created by WorkOS registration. It is read after the registration checkpoint. |
| `CHANNEL_E2E_INITIAL_MESSAGE_ID`                                                  | Optional original inbound Hi message ID from the secured test fixture; otherwise entered interactively.                   |
| `CHANNEL_E2E_EVIDENCE`                                                            | Optional receipt path; defaults to a new mode-0600 file in `/tmp`.                                                        |

The account export uses the existing `HarnessAccount` format. It needs `did`, `address`, `edSigningMnemonic`, `matrixUserId` and `matrixPassword` for the same registered test identity. Do not call `createHarnessAccount` to create a replacement. The test proves ownership through the actual scoped APIs and compares the account DID with Auth Hub's binding.

First run with `--check-config`. Then run normally, send the real initial Hi when prompted, and replay that exact provider message ID. Authenticate through the received Auth Hub link and give explicit consent. The script then sends a deterministic turn twice, verifies one canonical human message and decrypted encrypted-room provenance, and checks the same session/run after replay. After the operator confirms the WhatsApp response and Qi.Space continuity, it revokes the binding, verifies no new run and confirms that existing history and joined rooms remain intact.

The receipt separates automatic checks from operator confirmations. It does not contain credentials, phone numbers or message bodies. A failed run writes a failed receipt and stops. The local help and TypeScript checks do not constitute a live acceptance pass.

The normal path still needs global resource inventories to exclude duplicate identities outside the observed account, and a separate deployed fault-injection run for provisioning outages, lost responses and object resets. Existing real-workerd regressions cover those runtime recovery boundaries locally. Provider policy eligibility, a fresh WorkOS identity, chain/Matrix provisioning and the live transport must be approved and available before this harness can establish release readiness.
