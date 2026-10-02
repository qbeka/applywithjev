---
name: discover
description: Refresh the job queue without a browser. Use when the user says /discover, "find jobs", "refresh the queue", or before an /apply run when the queue is stale. Pulls every source, filters, rates with JEV, writes data/queue.json and data/applications.csv.
model: claude-sonnet-5-5
effort: high
---

# /discover: build the queue

No browser needed. Run from the repo root:

```
npx tsx src/cli.ts discover
```

It prints counts and the top 50 queued jobs with scores. Takes about a
minute and costs under ten cents of JEV.

Then show the user the top 15 as a short table (score, company, title,
location, posted) and one line of totals. Mention jobs that were skipped for
a reason they might want to override, grouped by reason, using
`npx tsx src/cli.ts status`.

Options:
- `--no-boards` skips polling company boards (faster, fewer fresh postings).
- `--limit N` rates only N new jobs, for a quick check.

To include the user's own tracking sheet, they export it as CSV into
`data/imports/` first; every file there is read on the next discover.

If it fails with an OPENROUTER_API_KEY error, point the user at
`docs/SETUP.md`. If a source fails, the run continues without it and says so
on stderr.
