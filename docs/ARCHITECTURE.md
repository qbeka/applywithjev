# Architecture

*How the pieces fit. Last verified 2026-10-02.*

## The split

| Who | Decides | Does not |
|---|---|---|
| **Code** (`src/`) | Which sources to read, deterministic filters (ATS, age, flags, title words), location tier from strings, work authorization per country, the score formula, what the CSV says | Judge meaning |
| **JEV** | Every typed judgement: fit questions per job, which key fills a field, which option, whether a checkbox applies, what kind of page this is | Write text, see pixels, hold state |
| **The runner** (`src/browser/`) | Opens the form, reads it, writes values with real input events, attaches the resume, reads every value back, clicks Submit on a ready form | Decide what a value should be |
| **Claude Code** (headless writer, and the skills) | Free-text answers, the fields JEV was unsure about, whether a required field can be answered truthfully at all | Invent facts, override authorization, create accounts, touch the browser |

The rule of thumb: if a question has a finite set of answers, it is JEV's.
If it needs a sentence, it is Claude's. If it is a rule, it is code.

## Discover pipeline (`src/discover.ts`)

```
fetchSimplify ──┐
fetchReadmeSources ─┤
importSheet(data/imports/*.csv) ─┼→ dedupe → preFilter → describe → rateJob → entryFor → queue.json
boards (greenhouse / lever / ashby for every company seen) ─┘                                   └→ applications.csv
```

1. **Collect.** Sources run concurrently. Board polling keeps only
   early-career titles (`EARLY_CAREER_TITLE`) because boards list every
   role.
2. **Dedupe** by posting (`postingKey` in `src/jobs/normalize.ts`). The
   lists and the boards link one job in several ways: a careers page with
   `gh_jid`, the board page, the embedded form, Ashby's `/application`. The
   big three are keyed by the ATS's own posting id, everything else by its
   canonical URL, so one posting is one queue entry and one CSV row. Merged
   records keep the richer fields.
3. **preFilter** (`src/jobs/hardFilters.ts`): account-walled ATSs and
   careers sites (`src/jobs/walled.ts`: a list in config plus the sites an
   apply run found behind a login), boards whose forms run over several
   pages, older than `DISCOVER.maxAgeDays`, titles that are plainly not
   software, French titles, advanced-degree-only, US with no-sponsorship or
   citizenship flags, unpaid. Reasons are kept and written to the CSV.
4. **describe** (`src/jobs/describe.ts`): ATS API text or page text, capped
   at `JEV.maxDescriptionChars`.
5. **rateJob** (`src/jobs/rate.ts`): one JEV call, fifteen questions,
   `scoreFromAnswers` turns them into a score, a decision and reasons. The
   term and graduation questions are worded from the profile's own
   graduation date. A posting that asks for another graduation date is
   ranked lower, not dropped: applying is the candidate's call.
6. **Queue** (`src/jobs/queue.ts`): sorted by score then recency. Entries
   from a previous run keep terminal statuses (applied, skipped, blocked) so
   nothing is applied to twice. Jobs already in a terminal state are not
   re-rated.

Timing on 2026-10-02: 4,748 unique postings, 478 rated, 61 seconds, $0.075.

## Apply loop (`src/browser/formRunner.ts`, `apply` in `src/cli.ts`)

Each job moves on its own through three steps, and nothing waits for the
batch (`pipeline` in `src/cli.ts`, pacing in `src/util/pace.ts`). Fills run
`RUN.fillConcurrency` at once, paced per site. The moment a fill ends, its
form goes to the writer, `RUN.writerConcurrency` at once. The moment a form
is ready, it is submitted: one click at a time, with `RUN.submitGapMs`
between two submissions to the same site. Each result is printed and
recorded when it happens.

Per job, in the runner's own Chrome window:

```
fillJob
  openForm ─→ the form URL, or its embedded ATS frame, or behind an Apply button
     │         password box → blocked, nothing typed
     │         error page → one unhurried retry
  dumpFields.js ─→ readDropdownOptions ─→ mapForm (JEV) ─→ applyFills ─→ uploads
     │                                                      read back, retry what did not stick
  secondLook ─→ JEV again, on the closest real options of a dropdown that refused a value
  report ─→ data/runs/<id>.report.json: every field, what the page shows, ready or not
resolveJob ─→ open fields → answer memory, then Claude (headless, no tools) for the rest → applyFills → read back → ready?
submitJob ─→ refuse unless ready ─→ re-read required fields ─→ click ─→ page-state (JEV) ─→ CSV
```

`applyUrl` (`applyUrlFor` in `src/jobs/normalize.ts`) is the direct form:
Greenhouse's embed page, Lever's `/apply`, Ashby's `/application`.

### The browser layer (`src/browser/cdp.ts`)

A small DevTools Protocol client with no dependency: Node 22 ships `fetch`
and `WebSocket`. It starts Chrome with its own profile under
`data/runs/chrome-profile`, a visible window the user can watch and take
over, and background throttling off so a tab behind another one still runs.
It gives the runner `evaluate`, real mouse and key input, file attachment,
and a count of the page's own writes (POST, PUT, PATCH) with any that failed.

### The form contract (`src/forms/fields.ts`)

- `dumpFields.js` runs in the page and returns a `FieldsDump`: every
  visible control with an `id` (f0, f1, …), a CSS `selector` that names
  exactly one element, `kind`, `label`, `hint`, `required`, current `value`,
  `options`, the submit buttons, embedded ATS iframes, and whether the page
  shows a password box. Labels come from `<label for>`, aria attributes or
  the enclosing label; a placeholder-style label ("Select", "Search") is
  replaced by the question text just above the control. Ids a UI library
  numbers on each render are not used as selectors. Button groups, Ashby's
  Yes/No buttons and role-based radio rows are read as one radio field.
- `mapForm` sends the fields and the candidate's facts and standing answers
  to JEV in chunks of `FORM.fieldsPerCall` and returns a `FillPlan`: per
  field an `action` (`fill`, `upload`, `draft`, `skip`, `review`), the chosen
  `key`, the `value`, and `confidence`. A list too long to show (countries,
  schools) is asked as "which value belongs here" and matched in code. Keys
  that would write the same text add their probabilities. A required salary
  box gets the profile's standing wording. An open question is always a
  draft, however unsure JEV is of its intent.
- `fillFields.js` writes plain controls: native value setters so React sees
  the change, `input` and `change` events, select by value then label,
  radios and button groups by label, checkboxes by click.
- `pageHelpers.js` reads dropdown components through their own props, which
  is instant and needs no clicking: react-select (Greenhouse) by `options`,
  `selectOption` and `loadOptions`; Ashby's search boxes by `onSearch`,
  `results` and `onSelect`. Anything else is opened with real clicks and
  typing, one tab at a time because that needs the tab in front.

### Verification, in layers

1. Every fill is read back from the control. Empty means one retry with real
   input, then a failure with the reason.
2. A control the form switched off after another answer is not a failure. A
   control whose selector no longer matches is.
3. A form that saves each field to its server (Ashby) is filled one field at
   a time, each waiting for its save. A refused save or upload is retried
   once, then fails the form.
4. A form is `ready` only with no draft, review or failure left and no
   required field empty. `submit` refuses anything else and re-reads the
   required fields first. An optional field that could not be set and that
   the page shows empty is not a failure: it is listed as left blank
   (`splitFailures`). A form with a Next button and no Submit is one page of
   several and is never ready.
5. After the click, JEV classifies the page. Only `submitted` is recorded as
   applied. Validation errors, a CAPTCHA or a login are recorded as they are.

### The answer memory (`src/answers/memory.ts`)

`data/memory.json` keeps what the writer decided, so a question is paid for
once. `resolveJob` looks there before it calls Claude, in this order:

1. **The same form, the same open fields.** The whole resolution (verdict,
   reason, answers, sheet note) is reused. This is the rehearsal followed by
   the real run: what was read is what is sent, and Claude is not called.
2. **The same form, other fields open.** JEV is sure of a field on one pass
   and unsure on the next, so the open set can differ. Answers the form got
   last time are reused field by field, if last time ended `ready`. A form
   that was held is judged whole again.
3. **The same question on another form.** The writer marks each answer
   `reusable` only when the value would be right on any company's form. Such
   an answer is stored under the question with the company's name masked,
   and reused when the kind of control matches and the field can take the
   value (the option exists, the text fits `maxLength`).
4. **A question worded another way.** JEV is asked one choice question per
   open field: which remembered question asks for exactly the same
   information, or none. Only a confidence of
   `MEMORY.sameQuestionConfidence` reuses the answer. On sixteen hand-made
   pairs and twenty-six real ones it made no wrong match at 0.9; it also
   missed several true paraphrases, which only costs a Claude call.

Three rules keep it from lowering accuracy. Every entry carries a
fingerprint of the writer's system prompt (the rules, the profile, the
drafts, the voice guide), so any change there makes the memory start over.
A group of checkboxes is answered from memory only when every box in it is.
An answer that was itself recalled is never stored again under the new
wording, so one "same question" judgement never builds on another. A reused
answer is written and read back like any other.

`memory` lists it, `memory --forget <text>` and `--clear` drop entries, and
`apply --fresh` ignores it for one run. `MEMORY.enabled` turns it off.

### Cost

`src/log/cost.ts` reads the two usage logs and reports spend by purpose and
per form. `apply` prints the cost of its own run at the end, and `cost`
prints it for any period. These choices keep the writer cheap:

- The answer memory, above.
- The candidate's context (voice guide, facts, drafts) is the system prompt,
  identical for every form, so the provider caches it. The first call of a
  process stores it; calls that start meanwhile wait for it and then read it
  at a tenth of the price.
- The cache is the five-minute one (`WRITER.env`). Writing to it costs 1.25
  times the input price; the one-hour cache costs 2 times, and a run reads
  the prompt back within seconds.
- The headless call runs in an empty folder outside the project
  (`WRITER.cwd`). Claude Code adds the `CLAUDE.md` of the folder it starts
  in to every prompt, which was about 1,300 tokens per call of rules about
  changing this code.
- A form with nothing left open makes no writer call at all.
- The writer returns the two sheet notes with its answers, since it has
  already read the posting. Jobs it was not asked about get their notes in
  one call for the whole run.

Measured on ten forms on 2026-10-02: JEV $0.012, Claude $0.17 at API prices
(was $0.23 before the last four points). The same ten forms again: Claude
$0.018. The README has the table.

### Speed

| Step | Typical |
|---|---|
| Open the form | 1 to 3 s (7 s behind a careers page that redirects) |
| Dump, read dropdown options | under 1 s |
| JEV mapping | about 0.5 s, $0.001 |
| Fill and read back | 0.2 s on Greenhouse, 3 to 6 s on Ashby (per-field saves) |
| Claude, when a form has open fields | 10 to 25 s, three forms at a time |

Forms run `RUN.fillConcurrency` at once, `RUN.perHostConcurrency` per site
with `RUN.hostGapMs` between starts, and one at a time on `RUN.gentleHosts`.
Job boards answer bursts with errors, so the pacing is part of correctness.

## Files

| Path | Format | Written by | Read by |
|---|---|---|---|
| `data/profile.json` | `ProfileSchema` | the user | everything |
| `data/bank.json`, `data/voice.local.md` | drafts per intent; the voice guide | the user | the writer, `answer-context` |
| `data/queue.json` | `QueueFile` v1 | discover, `apply`, `mark` | everything |
| `data/applications.csv` | 25 columns, first 15 match the user's sheet. Every job considered | discover, `apply`, `submit`, `mark` | the user, `log --all` |
| `applied.csv` | 15 columns with plain names. Only what was sent, newest first. Rebuilt on every save of the file above | the same commands | the user, `log` |
| `data/memory.json` | `MemoryFile` v1: whole resolutions by job id, and reusable answers by question | `resolve`, `apply` | `resolve`, `apply`, `memory` |
| `data/runs/jev-usage.jsonl` | one JSON object per JEV call: label, tokens, cost | `JevClient` | `cost`, the user |
| `data/runs/writer-usage.jsonl` | one JSON object per Claude call: purpose, job, tokens, cost | the writer | `cost`, the user |
| `data/runs/<id>.plan.json`, `<id>.report.json` | the dump and plan, and the verified result, per job | `fill`, `resolve` | `resolve`, `inspect`, `submit`, `survey` |
| `data/runs/browser-session.json` | which tab holds which job | `fill` | `resolve`, `set`, `inspect`, `submit` |
| `data/runs/chrome-profile/` | the runner's Chrome profile | Chrome | Chrome |
| `data/cache/walled-hosts.json` | careers sites found behind a login | `apply` | discover |
| `data/cache/http/` | cached GET bodies keyed by URL hash | `getText` | `getText` |

## Setup and `doctor` (`src/doctor.ts`)

`doctor` runs a list of checks (Node, Chrome, Claude Code, the key, the
profile, the resume, the voice guide, the drafts, the queue) and names the
first thing that blocks a run. `--online` adds one tiny JEV call and one
tiny Claude Code call. The `/setup` skill runs it after every step, so the
skill never has to work out where a half-finished setup stopped. The
questions the skill asks, and the profile field each answer fills, are in
`.claude/skills/setup/questions.md`.

## Why its own Chrome window and no browser library

The first version drove the user's Chrome through the Claude in Chrome
extension, one tool call per action. It worked and it was slow: a form took
minutes, a background tab runs its timers once a second, and every value
passed through the model on its way to the page. The runner talks to Chrome
directly, so a form is one command and the model only sees what JEV could
not settle. It needs no Playwright or Puppeteer: the DevTools Protocol is a
WebSocket and a dozen methods. The price is a separate browser profile with
no logged-in sessions, which is fine for the forms this tool targets (they
need no account) and is why a CAPTCHA or an email code still goes to the
person at the keyboard.
