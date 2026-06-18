/**
 * FlowsPlugin — the flagship flow-builder plugin. The agent builds, wires,
 * inspects, and form-fills multi-step action flows on top of the editor's Qi
 * Flow engine; the user runs the flow in the portal. The agent never executes,
 * signs, or holds a key (spec §6.3) — it only writes flow documents and reads
 * their state.
 *
 * Coexists with the editor plugin (documents/pages); it reuses the editor
 * plugin's Matrix provider + readers but contributes its own flow tools.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { buildAuthoringTools } from './tools/authoring.js';
import {
  buildDescribeActionTool,
  buildGetFlowTemplateTool,
  buildListActionsTool,
  buildListReferenceableFieldsTool,
} from './tools/discovery.js';
import { buildFormTools } from './tools/forms.js';
import {
  buildFlowStatusTool,
  buildGetStepTool,
  buildReadFlowTool,
} from './tools/inspect.js';
import { buildSettingsTools } from './tools/settings.js';

export interface FlowsPluginOptions {
  /** A long-lived Matrix client owned by the host app, shared across rooms. */
  matrixClient?: MatrixClient;
}

const manifest: PluginManifest = {
  title: 'Flows',
  summary:
    'Build, wire, and edit multi-step action flows, and fill their forms. Use whenever the user wants to ' +
    "create an automation/workflow, change a flow's steps or settings, fill a form, or check a flow's status. " +
    'The user runs the flow in the portal.',
  whenToUse: [
    'User wants to build a workflow/automation/flow from steps or actions.',
    "User wants to change a step's inputs, condition, trigger, schedule, or assignee.",
    'User wants to fill in a form/survey on a flow.',
    'User wants to inspect a flow or find out why a step failed.',
  ],
  whenNotToUse: [
    'Editing prose/pages/documents (use the editor).',
    'Actually executing/running/signing a step — that happens in the portal, by the user.',
  ],
  tags: ['flows', 'automation', 'workflow', 'forms'],
  category: 'automation',
  visibility: 'on-demand',
  stability: 'beta',
};

export class FlowsPlugin extends OraclePlugin {
  readonly name = 'flows';
  readonly version = '0.1.0';
  readonly manifest = manifest;

  private readonly matrixClient?: MatrixClient;

  constructor(options: FlowsPluginOptions = {}) {
    super();
    this.matrixClient = options.matrixClient;
  }

  override getRequestTools(_rtCtx: RuntimeContext): PluginTool[] {
    return [
      // Discovery (§3.1)
      buildListActionsTool(),
      buildDescribeActionTool(),
      buildListReferenceableFieldsTool(this.matrixClient),
      buildGetFlowTemplateTool(),
      // Inspect (§3.6)
      buildReadFlowTool(this.matrixClient),
      buildGetStepTool(this.matrixClient),
      buildFlowStatusTool(this.matrixClient),
      // Authoring (§3.3)
      ...buildAuthoringTools(this.matrixClient),
      // Settings mutators (§3.4)
      ...buildSettingsTools(this.matrixClient),
      // Forms (§3.5)
      ...buildFormTools(this.matrixClient),
    ];
  }
}
