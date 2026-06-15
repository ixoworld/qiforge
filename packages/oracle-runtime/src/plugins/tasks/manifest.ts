import type { PluginManifest } from '../../plugin-api/types.js';

export const tasksManifest: PluginManifest = {
  title: 'Scheduled Tasks',
  summary:
    "Schedule the main agent to run on time-based triggers and deliver the result to the user's oracle chat room (or a dedicated task room) — runs happen in the background, not inline in the current conversation.",
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
      user: 'Every weekday at 9am post a LinkedIn update about our latest blog, but let me approve it before it goes out.',
      thought:
        'An action task. Preview first. Use approval: before-action so each run drafts the post in its own [Task] room and asks the user to approve there before publishing — intent.requiresApproval names the guarded action.',
      tool: 'preview_task',
      args: {
        title: 'Daily LinkedIn Update',
        intent: {
          whatToDo:
            "Draft a short LinkedIn post about the company's latest blog article and propose it for approval before publishing.",
          howToReport: 'The ready-to-post text, with the article link.',
          constraints: ['Under 120 words.'],
          requiresApproval: 'publishing the post to LinkedIn',
        },
      },
    },
    {
      user: 'Looks good — schedule it and ask me before each one goes out.',
      thought:
        'Action task confirmed. Commit with approval: before-action — every run drafts in the [Task] room and the user approves by replying there; a plain "yes" is recorded automatically.',
      tool: 'create_task',
      args: {
        previewToken: '<token-from-preview_task>',
        title: 'Daily LinkedIn Update',
        trigger: { type: 'time.cron', pattern: '0 9 * * 1-5', tz: 'UTC' },
        intent: {
          whatToDo:
            "Draft a short LinkedIn post about the company's latest blog article and propose it for approval before publishing.",
          howToReport: 'The ready-to-post text, with the article link.',
          constraints: ['Under 120 words.'],
          requiresApproval: 'publishing the post to LinkedIn',
        },
        approval: 'before-action',
        dedicatedRoom: 'auto',
      },
    },
    {
      user: '(in the task room) Perfect, but fix the typo first then send.',
      thought:
        'Nuanced approval — act on it (fix the typo, publish), then record the decision.',
      tool: 'resolve_task_approval',
      args: {
        taskId: 'task_daily-linkedin-update_a1b2c3d4',
        outcome: 'approved',
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
      args: { taskId: 'task_morning-crypto-brief_a1b2c3d4' },
    },
  ],
  category: 'automation',
  visibility: 'on-demand',
  stability: 'beta',
  tags: ['scheduler', 'cron', 'automation', 'approval'],
};
