import type { PluginManifest } from '../../plugin-api/types.js';

export const tasksManifest: PluginManifest = {
  title: 'Scheduled Tasks',
  summary:
    'Schedule the main agent to run on time-based triggers and deliver the result.',
  whenToUse: [
    "User wants to set up a reminder or recurring report ('every morning at 7', 'tomorrow at 5pm', 'remind me to …')",
    'User wants the agent to monitor or track something on a schedule',
    'User wants the agent to run a piece of work later, without sitting in the chat',
  ],
  whenNotToUse: [
    'One-shot action the user wants done right now — just do it inline',
    'Real-time / streaming requirements — tasks run on a scheduled cadence, not on demand',
  ],
  examples: [
    {
      user: 'Every morning at 7 give me a one-paragraph crypto brief.',
      thought:
        'New recurring task. ALWAYS preview first so the user sees a real run before scheduling.',
      tool: 'preview_task',
      args: {
        title: 'Morning Crypto Brief',
        intent: {
          whatToDo:
            'Summarize BTC, ETH, SOL movement over the last 24h. Highlight any moves > 5%.',
          howToReport:
            'Concise paragraph + bullet list of movers. Link sources.',
          constraints: ['Under 300 words.', 'No trade recommendations.'],
        },
      },
    },
    {
      user: 'Looks good, schedule it.',
      thought:
        'Preview was shown. Commit the SAME title/intent with the previewToken.',
      tool: 'create_task',
      args: {
        previewToken: '<token-from-preview_task>',
        title: 'Morning Crypto Brief',
        trigger: { type: 'time.cron', pattern: '0 7 * * *', tz: 'UTC' },
        intent: {
          whatToDo:
            'Summarize BTC, ETH, SOL movement over the last 24h. Highlight any moves > 5%.',
          howToReport:
            'Concise paragraph + bullet list of movers. Link sources.',
          constraints: ['Under 300 words.', 'No trade recommendations.'],
        },
        approval: 'never',
        dedicatedRoom: 'auto',
      },
    },
    {
      user: 'What tasks do I have?',
      tool: 'list_my_tasks',
      args: {},
    },
    {
      user: 'Pause the crypto brief.',
      tool: 'pause_task',
      args: { taskId: 'task_a1b2c3d4e5f6' },
    },
    {
      user: "Send it, but next time include Solana's volume too.",
      thought:
        'A nuanced reply to a pending approval — approve now, then offer to update the task body.',
      tool: 'resolve_pending_approval',
      args: { decision: 'approve' },
    },
  ],
  category: 'automation',
  visibility: 'always',
  stability: 'beta',
  tags: ['scheduler', 'cron', 'automation', 'approval-gate'],
};
