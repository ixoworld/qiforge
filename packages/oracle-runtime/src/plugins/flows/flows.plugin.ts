/**
 * FlowsPlugin — the flagship flow-builder plugin. The agent designs reusable
 * flow *templates* by conversation (steps, data wiring, conditions, schedules,
 * assignees, forms), inspects live flow *runs*, and fixes the template when a
 * run reveals a build mistake. It builds on the editor's Qi Flow engine; the
 * user instantiates and runs the flow in the portal. The agent never executes,
 * signs, or holds a key (spec §6.3) — it only writes flow documents and reads
 * their state.
 *
 * It reuses the editor plugin's Matrix provider + readers but contributes its
 * own flow tools; it does not require the editor plugin to be loaded.
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
  buildListActionsTool,
  buildListReferenceableFieldsTool,
} from './tools/discovery.js';
import { buildFormTools } from './tools/forms.js';
import {
  buildExplainStepTool,
  buildFlowStatusTool,
  buildGetStepTool,
  buildReadFlowTool,
} from './tools/inspect.js';
import { buildLinkageTools } from './tools/linkage.js';
import { buildSettingsTools } from './tools/settings.js';

export interface FlowsPluginOptions {
  /** A long-lived Matrix client owned by the host app, shared across rooms. */
  matrixClient?: MatrixClient;
}

const manifest: PluginManifest = {
  title: 'Flow Builder',
  summary:
    'Design runnable automation flows by conversation. Build a reusable flow *template* (steps, data wiring, ' +
    'conditions, schedules, assignees, forms), inspect live flow *runs*, and fix the template when a run reveals a ' +
    'build mistake. The user instantiates and runs the flow in the portal.',
  whenToUse: [
    'User wants to build an automation/workflow/flow template from steps or actions.',
    "User wants to change a step's inputs, condition, trigger, schedule, or assignee.",
    'User wants to know what an action needs (its required inputs/outputs) before adding it.',
    'User wants to fill in a form/survey on a flow.',
    "User wants to inspect a flow run, find out why a step failed, and fix the template that built it.",
  ],
  whenNotToUse: [
    'Editing prose/pages/documents (use the editor).',
    'Actually executing/running/signing a step — that happens in the portal, by the user.',
  ],
  tags: ['flows', 'templates', 'automation', 'workflow', 'forms'],
  category: 'automation',
  visibility: 'always',
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
      // Linkage (§3.2)
      ...buildLinkageTools(this.matrixClient),
      // Inspect (§3.6)
      buildReadFlowTool(this.matrixClient),
      buildGetStepTool(this.matrixClient),
      buildFlowStatusTool(this.matrixClient),
      buildExplainStepTool(this.matrixClient),
      // Authoring (§3.3)
      ...buildAuthoringTools(this.matrixClient),
      // Settings mutators (§3.4)
      ...buildSettingsTools(this.matrixClient),
      // Forms (§3.5)
      ...buildFormTools(this.matrixClient),
    ];
  }
}
