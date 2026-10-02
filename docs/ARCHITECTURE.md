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

Per job, in the runner's own Chrome window, several forms side by side:

```
fillJob
  openForm ─→ the form URL, or its embedded ATS frame, or behind an Apply button
     │         password box → blocked, nothing typed
     │         error page → one unhurried retry
  dumpFields.js ─→ readDropdownOptions ─→ mapForm (JEV) ─→ applyFills ─→ uploads
     │                                                      read back, retry what did not stick
  secondLook ─→ JEV again, on the closest real options of a dropdown that refused a value
  report ─→ data/runs/<id>.report.json: every field, what the page shows, ready or not
resolveJob ─→ open fields → Claude (headless, no tools) → applyFills → read back → ready?
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
   required fields first.
5. After the click, JEV classifies the page. Only `submitted` is recorded as
   applied. Validation errors, a CAPTCHA or a login are recorded as they are.

### Cost

`src/log/cost.ts` reads the two usage logs and reports spend by purpose and
per form. `apply` prints the cost of its own run at the end, and `cost`
prints it for any period. Three choices keep the writer cheap:

- The candidate's context (voice guide, facts, drafts) is the system prompt,
  identical for every form, so the provider caches it. The first call of a
  run goes alone to store it; the calls after it read it at a tenth of the
  price.
- A form with nothing left open makes no writer call at all.
- The two sheet notes for every job applied to in a run are written in one
  call, not one call per job.

Measured on ten forms on 2026-10-02: JEV $0.012, Claude $0.23 at API prices.
The README has the table.

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
| `data/applications.csv` | 25 columns, first 15 match the user's sheet | discover, `apply`, `submit`, `mark` | the user |
| `data/runs/jev-usage.jsonl` | one JSON object per JEV call: label, tokens, cost | `JevClient` | `cost`, the user |
| `data/runs/writer-usage.jsonl` | one JSON object per Claude call: purpose, job, tokens, cost | the writer | `cost`, the user |
| `data/runs/<id>.plan.json`, `<id>.report.json` | the dump and plan, and the verified result, per job | `fill`, `resolve` | `resolve`, `inspect`, `submit`, `survey` |
| `data/runs/browser-session.json` | which tab holds which job | `fill` | `resolve`, `set`, `inspect`, `submit` |
| `data/runs/chrome-profile/` | the runner's Chrome profile | Chrome | Chrome |
| `data/cache/walled-hosts.json` | careers sites found behind a login | `apply` | discover |
| `data/cache/http/` | cached GET bodies keyed by URL hash | `getText` | `getText` |

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
