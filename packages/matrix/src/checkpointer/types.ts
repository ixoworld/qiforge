import { type BaseMessage } from '@langchain/core/messages';
import { type RunnableConfig } from '@langchain/core/runnables';
import {
  type Checkpoint,
  type CheckpointMetadata,
} from '@langchain/langgraph-checkpoint';

interface IGraphStateWithRequiredFields {
  messages?: BaseMessage[];
  matrixReplyThreadId?: string;
  [key: string]: unknown;
}

interface IRunnableConfigWithRequiredFields extends RunnableConfig {
  configurable: {
    configs?: {
      matrix: {
        roomId: string;
        oracleDid: string;
        homeServerName: string;
      };
      user: {
        did: string;
        matrixOpenIdToken?: string;
        timezone?: string;
        currentTime?: string;
      };
    };
    thread_id?: string;
    checkpoint_ns?: string;
    checkpoint_id?: string;
    requestId?: string;
    [key: string]: unknown;
  };
}

interface ICheckpoint<
  GraphState extends IGraphStateWithRequiredFields,
> extends Checkpoint {
  channel_values: GraphState;
}

interface ICheckpointRow<
  GraphState extends IGraphStateWithRequiredFields = Record<string, unknown>,
> {
  checkpoint: ICheckpoint<GraphState>;
  metadata: CheckpointMetadata;
  parent_checkpoint_id?: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  type?: string;
}

interface IWritesRow {
  thread_id: string;
  checkpoint_ns?: string;
  checkpoint_id?: string;
  task_id: string;
  idx: number;
  channel: string;
  type?: string;
  value?: string;
}

type DataStoreStructure<GraphState extends IGraphStateWithRequiredFields> =
  Record<
    string,
    {
      checkpoints: ICheckpointRow<GraphState>[];
      writes: IWritesRow[];
    }
  >;

type SaveStateParams<GraphState extends IGraphStateWithRequiredFields> = {
  threadId: string;
  config: NonNullable<
    IRunnableConfigWithRequiredFields['configurable']['configs']
  >;
  checkpointNamespace?: string;
  checkpointId?: string;
  value?: ICheckpointRow<GraphState>;
  writesValue?: IWritesRow;
};

export type {
  DataStoreStructure,
  ICheckpointRow,
  IGraphStateWithRequiredFields,
  IRunnableConfigWithRequiredFields,
  IWritesRow,
  SaveStateParams,
};
