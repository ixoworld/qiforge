export {
  CredentialsPlugin,
  type CredentialsPluginOptions,
} from './credentials.plugin';
export {
  createCredentialsTools,
  SUPPORTED_ACTIONS,
  WHATSAPP_PROVIDER,
  whatsAppBinding,
  type CredentialsToolsDeps,
  type SupportedAction,
} from './credentials-tools';
export {
  CREDENTIALS_DEFAULT_URLS,
  credentialsConfigSchema,
  didWebOf,
  HUB_DEFAULT_URLS,
  resolveCredentialsConfig,
  SELF_DEFAULT_URLS,
  type CredentialsConfig,
  type CredentialsNetwork,
} from './config';
export {
  canonicalJson,
  HubPermissionsClient,
  permissionBodySha256,
  PERMISSIONS_CAPABILITY,
  PERMISSIONS_PATH,
  type PermissionCard,
  type PermissionGrant,
  type PermissionRequest,
  type PermissionState,
  type PermissionStatus,
} from './hub-client';
export {
  CredentialsWorkerClient,
  mergeVerifierAccept,
  VERIFY_CAPABILITY,
  VerifierEntryMemo,
  type VerifierAccept,
  type VerifierEntry,
} from './credentials-client';
export {
  LINK_CAPABILITY,
  LINKS_PATH,
  SelfLinksClient,
  type LinkState,
  type LinkStatus,
} from './self-client';
export {
  credentialsResponseRoute,
  openResponseToken,
  RESPONSE_ROUTE_PATH,
  sealResponseToken,
  type VerifyInOwner,
} from './response-route';
export {
  CredentialsServiceError,
  refusalFor,
  type CredentialsRefusal,
  type CredentialsService,
} from './errors';
