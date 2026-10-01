/**
 * FlowsPlugin — the flow-builder plugin. The agent designs reusable flow
 * *templates* by conversation (steps, data wiring, conditions, schedules,
 * assignees, forms), inspects live flow *runs*, and fixes the template when a
 * run reveals a build mistake. It builds on the editor's Qi Flow engine; the
 * user instantiates and runs the flow in the portal. The agent never executes,
 * signs, or holds a key — it only writes flow documents and reads their state.
 *
 * It reuses the editor plugin's Matrix provider + readers but contributes its
 * own flow tools; it does not require the editor plugin to be loaded.
 *
 * This module must stay statically LIGHT: `new FlowsPlugin()` happens at
 * Worker module scope, and the tool builders' module graph (`tools/*` →
 * actions/translator → `@ixo/editor/core` → `@ixo/matrix-crdt` → vscode-lib)
 * schedules a timer during module evaluation (vscode-lib's
 * `IdleValue`/`runWhenIdle`), which workerd forbids in global scope. The tool
 * modules are therefore reached only via `await import()` inside
 * `getRequestTools`, which runs per turn inside a Durable Object request
 * context where timers are allowed.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { FLOWS_PLUGIN_NAME } from './prompts';

export interface FlowsPluginOptions {
  /** A long-lived Matrix client owned by the host (or a test), shared across rooms. */
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

  override async getRequestTools(
    _rtCtx: RuntimeContext,
  ): Promise<PluginTool[]> {
    // Lazy on purpose — see the module header. The module registry caches the
    // imports, so only the first turn in an isolate pays for them.
    const [authoring, discovery, forms, inspect, linkage, settings] =
      await Promise.all([
        import('./tools/authoring'),
        import('./tools/discovery'),
        import('./tools/forms'),
        import('./tools/inspect'),
        import('./tools/linkage'),
        import('./tools/settings'),
      ]);

    return [
      // Discovery
      discovery.buildListActionsTool(),
      discovery.buildDescribeActionTool(),
      discovery.buildListReferenceableFieldsTool(this.matrixClient),
      // Linkage
      ...linkage.buildLinkageTools(this.matrixClient),
      // Inspect
      inspect.buildReadFlowTool(this.matrixClient),
      inspect.buildGetStepTool(this.matrixClient),
      inspect.buildFlowStatusTool(this.matrixClient),
      inspect.buildExplainStepTool(this.matrixClient),
      // Authoring
      ...authoring.buildAuthoringTools(this.matrixClient),
      // Settings mutators
      ...settings.buildSettingsTools(this.matrixClient),
      // Forms
      ...forms.buildFormTools(this.matrixClient),
    ];
  }
}
