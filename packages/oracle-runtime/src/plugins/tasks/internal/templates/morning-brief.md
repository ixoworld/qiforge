# Morning Brief

Catch the user up on N topics at a fixed daily time.

**Trigger:** `time.cron` daily — typically `0 7 * * *` in the user's timezone.

## What to do

Summarize the latest movement / news for the topics the user named.
Use the web tools available to the agent (Composio search, Firecrawl,
or any loaded scraping plugin) to pull current data — never rely on
internal memory for time-sensitive info.

## How to report

Concise paragraph + bullet list of highlights. Link sources where you can.

## Constraints

- Keep it under 300 words.
- Don't recommend trades / actions; just inform.
