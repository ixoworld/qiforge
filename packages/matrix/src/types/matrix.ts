export interface IRoomCreationOptions {
  name: string;
  alias: string;
  adminUserId: string;
  inviteUserId: string;
}

export interface IMessageOptions {
  roomId: string;
  message: string;
  isOracleAdmin?: boolean;
  oracleName?: string;
  threadId?: string;
  disablePrefix?: boolean;
  /**
   * Full Matrix user IDs to intentionally mention (`m.mentions.user_ids`).
   * Mentioned users receive a push notification per the Matrix intentional
   * mentions spec. Omitted/empty → the event carries an explicit empty
   * `m.mentions` (current behavior: no one is mentioned).
   */
  mentions?: string[];
  /** Custom fields spread onto the Matrix event content (e.g. `{ 'ixo.task_id': '...' }`) */
  metadata?: Record<string, unknown>;
}

export interface ICreateRoomAndJoinOptions {
  did: string;
  oracleName: string;
  userAccessToken: string;
}

export interface IAction {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
  success: boolean;
}
