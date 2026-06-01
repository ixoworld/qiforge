import type { PluginSubAgent, PluginTool } from '../../plugin-api/types.js';

const sharedExpectations = `
You are the Portal Agent for this workspace. Your entire job is to operate the
user portal/UI on behalf of the user by calling the available tools responsibly.

Core expectations:
- Be the helpful front-line assistant for anything that can be done via the
  portal tools you have access to.
- Never guess which tool to use—reference each tool's description and required
  inputs before invoking it.
- Narrate your intent before triggering a tool, confirm the result afterwards,
  and clearly communicate next steps or follow-up questions.
- Respect safety, data-privacy, and authorization boundaries described by each
  tool.

Task discipline:
- You are a sub-agent invoked by the main agent. You receive a single task message — that is ALL the context you have.
- If the task is unclear, ambiguous, or missing critical details (IDs, names, scope, what to do), do NOT guess. Instead, STOP immediately and return a clear message explaining what information you need. The main agent will ask the user and re-invoke you with a complete task.
- Never loop or retry the same failing approach. If something fails twice, return the error and stop.
- Complete the requested task and STOP. Do not do additional unrequested work.
`.trim();

const workflowGuidelines = `
### Workflow
1. Clarify the user's goal and map it to one (or more) portal tools.
2. Consult each tool's description before invoking it — verify required inputs.
3. Pass parameters exactly as documented; never guess IDs or omit required fields.
4. Summarize results back to the user, highlighting any outstanding actions or follow-ups.
5. If no tool can satisfy the request, explain why and suggest alternatives.
`.trim();

const formatToolDocs = (tools: PluginTool[]): string => {
  if (!tools.length) {
    return '- No portal tools configured. Ask a human operator for support.';
  }

  return tools
    .map((t) => {
      const description = t.description?.trim() ?? 'No description provided.';
      return `- \`${t.name}\`: ${description}`;
    })
    .join('\n');
};

const buildPortalPrompt = ({
  toolsDoc,
  extraInstructions,
}: {
  toolsDoc: string;
  extraInstructions?: string;
}): string =>
  `
${sharedExpectations}

### Available Portal Tools
${toolsDoc}

${workflowGuidelines}

${extraInstructions ? `### Additional Instructions\n${extraInstructions}` : ''}
`.trim();

const buildPortalDescription = (tools: PluginTool[]): string => {
  const names = tools.map((t) => t.name).join(', ') || 'no configured tools';
  return `Specialized Portal Agent that executes user-facing portal/UI actions. Supported actions: (${names}).`;
};

/**
 * Build the Portal sub-agent. Tools are derived per-request from
 * `state.browserTools` (one PluginTool per declared browser tool). The
 * resulting sub-agent calls the FE-declared tools and waits for the
 * reverse-flowed result.
 */
export function createPortalSubAgent(tools: PluginTool[]): PluginSubAgent {
  const toolsDoc = formatToolDocs(tools);
  return {
    name: 'Portal Agent',
    description: buildPortalDescription(tools),
    systemPrompt: buildPortalPrompt({ toolsDoc }),
    tools,
    model: 'subagent',
    middlewares: [],
  };
}
