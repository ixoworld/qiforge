import type { PluginManifest } from '../../plugin-api/types';

export const tasksManifest: PluginManifest = {
  title: 'Scheduled Tasks',
  summary:
    "Schedule the agent to run on time-based triggers and deliver the result to the user's oracle chat room — runs happen in the background on the user's own oracle, not inline in the current conversation.",
  whenToUse: [
    "User wants to set up a reminder or recurring report ('every morning at 7', 'tomorrow at 5pm', 'remind me to …')",
    'User wants the agent to monitor or track something on a schedule',
    'User wants the agent to run a piece of work later, without sitting in the chat',
    "User replies to a pending task-approval request ('yes, send it', 'no, drop it')",
  ],
  whenNotToUse: [
    'One-shot action the user wants done right now — just do it inline',
    'Real-time / streaming requirements — tasks run on a scheduled cadence, not on demand',
  ],
  examples: [
    {
      user: 'Every morning at 7 give me a one-paragraph crypto brief.',
      thought:
        'New recurring task. ALWAYS preview first so the user sees the schedule and confirms before anything is created.',
      tool: 'preview_task',
      args: {
        title: 'Morning Crypto Brief',
        intent:
          'Summarize BTC, ETH, SOL movement over the last 24h. Highlight any moves > 5%. Keep it under 300 words, no trade recommendations.',
        schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      },
    },
    {
      user: 'Looks good, schedule it.',
      thought:
        'The user confirmed after seeing the preview. Create with the SAME title/intent/schedule.',
      tool: 'create_task',
      args: {
        title: 'Morning Crypto Brief',
        intent:
          'Summarize BTC, ETH, SOL movement over the last 24h. Highlight any moves > 5%. Keep it under 300 words, no trade recommendations.',
        schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
        approval: 'never',
      },
    },
    {
      user: 'Every weekday at 9am post a LinkedIn update about our latest blog, but let me approve it before it goes out.',
      thought:
        "An action task — set approval to 'before-action' so each run asks the user in their room before it executes.",
      tool: 'create_task',
      args: {
        title: 'Daily LinkedIn Update',
        intent:
          "Draft and publish a short LinkedIn post (under 120 words) about the company's latest blog article, with the article link.",
        schedule: { kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' },
        approval: 'before-action',
      },
    },
    {
      user: '(replying to an approval request) Yes — go ahead.',
      thought:
        'The user approved the pending run — record it; approval executes the run and delivers the result.',
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
  tags: ['scheduler', 'cron', 'automation', 'approval', 'background'],
};
