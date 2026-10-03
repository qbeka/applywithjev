---
name: report
description: Show the user their job-search dashboard. Use when the user says /report, "show me my applications", "how is the search going", or wants to change the status of an application by hand. Starts a page on their own machine that reads every record and lets them set a status or a note per row.
model: claude-sonnet-5-5
effort: low
---

# /report: the dashboard

Run from the repo root:

```
npx jev report --open
```

It starts a page on the user's machine (`http://127.0.0.1:4545`) and opens
it. The page reads `applications/all.csv` and shows: applications sent,
today, waiting for the user, left for the user, queued, skipped; sent per
day and per job board; every job considered by status; and a table with
tabs (Applied, Left for you, Take-home, Queued, Everything), a filter, and
sortable columns.

Each row has a status select and a notes box. A change is saved at once to
the queue and the records, the same as `mark <id> --status ...`. Tell the
user that, and that the command keeps running until they press Ctrl-C.

`npx jev report --static applications/report.html` writes a self-contained
snapshot page instead, for keeping or sending; statuses cannot be changed
from a snapshot.
