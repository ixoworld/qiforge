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
import { FLOWS_PLUGIN_NAME } from './prompts.js';

export interface FlowsPluginOptions {
  /** A long-lived Matrix client owned by the host app, shared across rooms. */
  matrixClient?: MatrixClient;
}

/**
 * Discovery surface (returned by `list_capabilities` / `load_capability`). The
 * `summary` is the one-line teaser; `whenToUse`/`whenNotToUse`/`examples` teach
 * the agent when and how to load it. The full operating contract lives in
 * `FLOWS_OPERATING_GUIDE` (prompts.ts), injected into the system prompt once
 * the capability is loaded — kept out of the manifest so it costs no tokens on
 * turns where flows is never used.
 */
const manifest: PluginManifest = {
  title: 'Flow Builder',
  summary:
    'Build runnable automation flows by conversation. Assemble a reusable flow *template* from action blocks — wiring each step into the next, with conditions, schedules, assignees, and forms — then the user reviews and runs it in the portal. You design and write the flow in planning mode (propose the blocks, confirm, then build); you never execute, sign, or run a step.',
  whenToUse: [
    'User wants to build an automation/workflow/flow from steps or actions.',
    "User wants to change a step's inputs, condition, trigger, schedule, or assignee.",
    'User wants to know what an action needs (its inputs/prerequisites) before adding it.',
    'User wants to fill in a form/survey on a flow.',
    'User wants to inspect a flow run, find out why a step failed, and fix the template.',
  ],
  whenNotToUse: [
    'Editing prose/pages/documents (use the editor).',
    'Actually executing/running/signing a step — that happens in the portal, by the user.',
  ],
  examples: [
    {
      user: 'Build a flow that emails the applicant when their claim is approved',
      thought:
        'Discover the blocks and their requirements first, then propose a plan before writing anything.',
      tool: 'list_actions',
      args: { tag: 'claims' },
    },
    {
      user: 'What does the submit-claim step need before I can add it?',
      tool: 'describe_action',
      args: { action: 'qi/claim.submit' },
    },
    {
      user: 'Why did the second step of my flow fail?',
      tool: 'flow_status',
    },
  ],
  tags: ['flows', 'templates', 'automation', 'workflow', 'forms'],
  category: 'automation',
  visibility: 'on-demand',
  stability: 'beta',
};

export class FlowsPlugin extends OraclePlugin {
  readonly name = FLOWS_PLUGIN_NAME;
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
