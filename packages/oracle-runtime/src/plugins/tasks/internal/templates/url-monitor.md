# URL Monitor

Watch a single URL and notify when something material changes.

**Trigger:** `time.cron` — typically every 30-60 minutes for active sites,
hourly for slower ones.

## What to do

Fetch the page (use Firecrawl if loaded, otherwise the agent's web tools).
Compare key signals (title, headline, named entity, price, status code) to
what you reported last time. If it's the same, say so concisely.

## How to report

- If unchanged: a single line `No change — <signal>` so the user can scroll past.
- If changed: a short paragraph explaining what changed and why it matters.

## Constraints

- Don't dump the whole page; surface the delta.
- If the page is down, say so once — don't spam alerts.
