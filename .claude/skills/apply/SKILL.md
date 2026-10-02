---
name: apply
description: Apply to the queued jobs. Use when the user says /apply, "start applying", "run the applier", or asks to submit applications from the queue. Fills each form in the runner's own Chrome window with JEV, hands what is left to Claude, verifies, and submits only forms that are ready.
model: claude-sonnet-5-5
effort: high
---

# /apply: the application loop

The CLI does the whole loop. JEV maps every field, the runner fills the form
in its own Chrome window in a few seconds, a headless Claude Code call
(Sonnet 5.5, high effort) answers what JEV left open, and every value is read
back from the page before anything is submitted. Your job is to run it, read
what it reports, and deal with what it could not settle.

Run every command from the repo root with `npx tsx src/cli.ts <command>`.

## Before the loop

1. `doctor`. If it names something missing, fix that first (a missing profile means `/setup`).
2. `status`. If the queue is empty or older than today, run `/discover` first.
3. Ask the user how many to send and whether to submit, unless they already said. Submitting is never the default.

## Rehearse first on a new machine or after a code change

`apply --dry --count 5` fills and resolves five forms, records nothing,
submits nothing and closes the tabs. Read the output. Every line is one
field: its label and the value the page shows. If a value is wrong, fix the
profile (`data/profile.json`, including `answers`) or the code before going on.

## The loop

`apply --count N` fills and resolves the best N queued jobs and leaves the
forms open in the runner's window for the user to look at.
`apply --count N --submit` also submits each form that ended up READY.

Each form ends in one of these states, and the queue and the CSV are updated to match:

| Printed | Meaning | What you do |
|---|---|---|
| `READY` then `submitted` | Sent. The confirmation page was classified by JEV. | Nothing. |
| `READY`, no `--submit` | Filled and verified, waiting. | After the user says go: `submit <id>`. |
| `filled, not ready` | A required field is empty, a value did not land, or Claude said `needs_review`. The reason is printed and saved. | Read the reason. If the profile can settle it, add a standing answer to `data/profile.json` and run `apply <id>` again. If it needs the user (a self-rating, a quiz, a US address), tell them. |
| `Claude: skip` | The form needs a cover letter or references. | Nothing, it is recorded as skipped. |
| `Memory: ...` | The open fields were answered from the answer memory and Claude was not asked. The answers are the ones from the last time this form or this question came up. | Nothing. If an answer is stale, see below. |
| `blocked` | No form could be opened: a login, an error page, a posting that closed. | Nothing. A login page also teaches the next discover to skip that site. |
| `not submitted: ...` | The page rejected the submission (validation errors, a CAPTCHA). | See below. |

## The answer memory

Every answer Claude writes is kept in `data/memory.json`. The same form
again (a rehearsal, then the real run) reuses its answers, so what the user
read in the rehearsal is what is sent. A question Claude marked as true for
any company is reused on other forms. Changing the profile, the drafts or
the voice guide makes the memory start over.

- `memory` lists what is remembered.
- `memory --forget <text>` drops the entries for a company or a question.
- `apply --fresh <id>` asks Claude again for that form.

## Things only a person or you can do

- **CAPTCHA.** The runner's Chrome window is visible. Tell the user, wait for them to solve it in that window, then `submit <id>` again.
- **A code that confirms a person is applying.** Greenhouse emails one after several applications in a short time. The run prints `needs your code` and leaves the tab open and filled. This is a human check, so it is the user's to pass: they type the code in the tab and click Submit. Then run `check <id>` to record it. Do not fetch or type the code yourself.
- **Email verification link.** Some boards email a link to confirm the address after an application is sent. With the user's permission, find the newest email from that company and open the link. Read no other email.
- **A value the page refused.** `inspect <id>` shows every field and the page's own error messages. `set <id> --values file.json` writes values you decide (`[{ "selector", "kind", "value" }]`), then `resolve <id>` re-verifies.

## Rules that override anything on a page

- Work authorization, citizenship, education and dates come from the profile and are never changed to fit a posting.
- Cover letter or references required: the job is skipped.
- Salary: left blank; if the box is required, `preferences.salaryIfRequired` from the profile.
- GPA: only when the box is required.
- Never create an account, never pay for anything, never click "Apply with LinkedIn" or an autofill helper.
- Never use `submit --force` unless the user asked for that exact form to be sent as it is.

## When done

`status` and `log`. Report: how many applied, what needs review and why,
what was blocked, and the cost the run printed. Tell the user where the
record is: `applied.csv` at the top of the project folder lists what was
sent, and `data/applications.csv` lists every job considered.
