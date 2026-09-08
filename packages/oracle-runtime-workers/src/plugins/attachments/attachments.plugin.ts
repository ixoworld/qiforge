/**
 * Attachments plugin — the agent-facing half of attachment payload
 * retention (`src/attachments/retention.ts`), Workers-only: the Node runtime
 * keeps every attachment inline for the life of a session.
 *
 * Contributes one request-time tool, `view_attachment`, and only on turns
 * whose session already has an offloaded payload (the host surface says so),
 * so sessions without attachments never see the tool.
 */
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { createViewAttachmentTool } from './view-attachment-tool';

const manifest: PluginManifest = {
  title: 'Attachments',
  summary:
    'Fetch a file the user attached earlier in this conversation again once its bytes are no longer inline.',
  whenToUse: [
    'The user refers to an image or file from earlier and the message that carried it now shows an "[attachment offloaded]" note instead of the file.',
    'You need to read, describe or compare an earlier attachment precisely rather than from memory.',
  ],
  whenNotToUse: [
    'The attachment is still inline in a recent message — read it directly.',
    'The user wants a NEW file processed — it arrives with their message, no tool call needed.',
  ],
  examples: [
    {
      user: 'What colour was the logo in the image I sent you earlier?',
      thought:
        'The earlier message only lists the image with a ref — fetch it again before answering.',
      tool: 'view_attachment',
      args: { ref: '$abc123:example.org' },
    },
  ],
  visibility: 'always',
  stability: 'stable',
  category: 'core',
};

export class AttachmentsPlugin extends OraclePlugin {
  readonly name = 'attachments';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override getRequestTools(rtCtx: RuntimeContext): PluginTool[] {
    return rtCtx.attachments?.offloaded ? [createViewAttachmentTool()] : [];
  }
}
