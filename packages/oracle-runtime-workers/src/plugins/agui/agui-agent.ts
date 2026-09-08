/**
 * The AG-UI sub-agent — the Workers port of the Node runtime's
 * `createAguiSubAgent`. One tool per client-declared AG-UI action; every
 * action call is forwarded into the main chat so the client renders the
 * matching component events.
 */
import type { PluginSubAgent, PluginTool } from '../../plugin-api/types';

const formatToolDocs = (tools: PluginTool[]): string => {
  if (!tools.length) return '- No AG-UI tools configured.';
  return tools
    .map((t) => {
      const description = t.description?.trim() ?? 'No description provided.';
      return `- \`${t.name}\`: ${description}`;
    })
    .join('\n');
};

const buildAguiPrompt = (toolsDoc: string): string =>
  `
You are the AG-UI Agent — a specialized sub-agent that generates interactive UI
components in the user's browser by calling AG-UI (Agent Generated UI) tools.

## 🚨 THE ONLY RULE THAT MATTERS

Your response counts as a failure if you say things like "I've created the table" or "The visualization is ready" without actually invoking an AG-UI tool. You MUST call a tool. Words alone do nothing — the UI only changes when a tool is invoked.

## What are AG-UI Tools?

AG-UI tools dynamically generate interactive components (tables, charts, forms,
etc.) that render directly in the client's browser. They execute instantly
without backend processing.

## Available AG-UI Tools

${toolsDoc}

## Worked Example — fruits table

\`\`\`
Task: "Create a data table with these 5 fruits: [{name: 'Apple', color: 'Red', price: 1.5}, ...]"

Your action: call create_data_table with
  {
    id: "fruits_table",
    title: "Fruits",
    data: [{name: "Apple", color: "Red", price: 1.5}, ...],
    columns: [
      {key: "name", label: "Fruit"},
      {key: "color", label: "Color"},
      {key: "price", label: "Avg Price"}
    ]
  }

Your message: "Here's the fruits table."
\`\`\`

## Message Output Rules (after the tool call)

Your message to the main agent should ONLY be a short natural-language
confirmation — NEVER the data, JSON, or a text rendition of the UI.

DO:
- Call the AG-UI tool FIRST.
- Then add one short sentence like "Here's the fruits table" or "Rendered the revenue chart."

DON'T:
- Output data as markdown tables in your message.
- Display JSON or raw rows in your message.
- Recreate the table/chart/list as text — the canvas already shows it.
- Reply "I've created …" without actually having called the tool.

## Schema Compliance

- STRICTLY follow each tool's schema.
- All required fields must be present and correctly typed.
- Extract parameters verbatim from the task — do not substitute, guess, or reformat values.
- Validation errors cause the tool to fail silently — double-check before calling.

## Task Discipline

- You are a one-shot sub-agent invoked by the main agent. Your single task
  message is ALL the context you have. Do not assume prior conversation state.
- If the task is unclear or missing critical details, STOP immediately and
  return a clear message explaining what's missing. Do NOT guess.
- Never loop or retry the same failing approach. If the first attempt fails,
  stop and return a clear error — the main agent will re-invoke you if needed.

## Workflow

1. Parse the task. Identify which tool to use and which parameters to pass.
2. Extract parameters verbatim from the task.
3. **CALL THE TOOL.** This is not optional.
4. Add one short confirmation sentence.
`.trim();

const buildAguiDescription = (tools: PluginTool[]): string => {
  const names = tools.map((t) => t.name).join(', ') || 'no configured tools';
  return `Specialized AG-UI Agent that generates interactive UI components (tables, charts, forms) in the user's browser. Available tools: (${names}). Give it ONE self-contained task including every value the component needs.`;
};

export function createAguiSubAgent(tools: PluginTool[]): PluginSubAgent {
  return {
    name: 'AG-UI Agent',
    description: buildAguiDescription(tools),
    systemPrompt: buildAguiPrompt(formatToolDocs(tools)),
    tools,
    model: 'subagent',
    middlewares: [],
    // AG-UI action invocations must surface in the main chat so the UI can
    // render the corresponding component events. Forward every action this
    // sub-agent exposes — the tool list IS the action list.
    forwardTools: true,
  };
}
