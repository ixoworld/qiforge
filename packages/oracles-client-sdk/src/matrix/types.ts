type MatrixClientConstructorParams = {
  userAccessToken: string;
  appServiceBotUrl?: string;
  homeserverUrl?: string;
};

type SourceSpacePayload = {
  userDid: string;
};

type JoinSpaceOrRoomPayload = {
  roomId: string;
};

type CreateAndJoinOracleRoomPayload = {
  oracleEntityDid: string;
  userDid: string;
};

type MatrixRoomMember = {
  type: string;
  room_id: string;
  sender: string;
  content: {
    displayname?: string;
    membership: 'join' | 'leave' | 'invite' | 'ban';
  };
  state_key: string;
  origin_server_ts: number;
  unsigned?: {
    replaces_state?: string;
    age?: number;
  };
  event_id: string;
  user_id: string;
  age?: number;
  replaces_state?: string;
};

type MatrixRoomMembersResponse = {
  chunk: MatrixRoomMember[];
};

type MatrixPowerLevels = {
  users: Record<string, number>;
};

export type {
  CreateAndJoinOracleRoomPayload,
  JoinSpaceOrRoomPayload,
  MatrixClientConstructorParams,
  MatrixPowerLevels,
  MatrixRoomMember,
  MatrixRoomMembersResponse,
  SourceSpacePayload,
};
export interface IOpenIDToken {
  access_token: string;
  token_type: 'Bearer' | string;
  matrix_server_name: string;
  expires_in: number;
}

export type SourceSpaceResponse = {
  success: boolean;
  space_id: string;
  space_alias: string;
  privacy: {
    encrypted: boolean;
    join_rule: string;
    history_visibility: string;
  };
  rooms: unknown[];
  subspaces: {
    oracles: {
      space_id: string;
      space_alias: string;
      privacy: {
        encrypted: boolean;
        join_rule: string;
        history_visibility: string;
      };
      rooms: unknown[];
    };
    /**
     * Community subspace — optional until the rooms-bot ships it (see
     * qiforge `specs/spaces-source-support-room.md`). Its Support room
     * (`<hyphenated entity DID>-sup`) is where the scaffold adds the
     * entity's designated support accounts with moderation power.
     */
    community?: {
      space_id: string;
      space_alias: string;
      privacy: {
        encrypted: boolean;
        join_rule: string;
        history_visibility: string;
      };
      rooms: unknown[];
      support_room?: {
        room_id: string;
        room_alias: string;
      };
    };
  };
};
