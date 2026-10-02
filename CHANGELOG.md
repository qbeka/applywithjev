# Changelog

All notable changes to this project are recorded here. The format follows
Keep a Changelog and the project uses Conventional Commits.

## [Unreleased]

### Added
- Fill runner (`src/browser/`): drives its own Chrome window over the
  DevTools protocol with no browser library. A form is dumped, mapped by JEV,
  filled, and every value read back, in 2 to 12 seconds. Forms run side by
  side with pacing per site.
- `apply`, `fill`, `resolve`, `inspect`, `set`, `submit`, `survey` and `close`
  commands. `apply --dry` rehearses without recording or submitting.
- Claude as the fallback writer (`src/answers/resolve.ts`): open questions
  and the fields JEV was unsure of go to a headless Claude Code call pinned
  to Sonnet 5.5 at high effort, with no tools, and come back as JSON.
- Standing answers in the profile (`answers`), read by JEV and by Claude.
- Dropdowns set through the component's own props: react-select on
  Greenhouse, including lazy and paginated lists, and Ashby's search boxes.
  A second JEV look picks among the closest real options when a dropdown
  refuses the first value.
- Readiness and a submit guard: a form is submitted only when every wanted
  value is confirmed on the page and no required field is empty, and the page
  after the click must be a confirmation.
- Per-field save tracking for boards that save as you type (Ashby), with a
  retry when the server refuses a save or an upload.
- `data/bank.json` and `data/voice.local.md`: the candidate's own drafts and
  voice guide, git-ignored, with examples in the repo.
- Sites found behind a login during a run are remembered and skipped by the
  next discover.

- `cost` command and a cost summary at the end of every `apply` run: JEV and
  Claude spend by purpose, per form and per ten forms. Every Claude call is
  logged with its tokens and cost in `data/runs/writer-usage.jsonl`.
- The README is rewritten in plain language, with measured cost and accuracy
  tables. `CONTRIBUTING.md` says how the docs are written.

- `/setup` skill: from a fresh clone to the first rehearsal in one
  conversation. It builds the profile from the resume and a short interview,
  has the user add their own key, finds jobs and rehearses. The questions it
  asks are in `.claude/skills/setup/questions.md`.
- `doctor` command: checks everything a run needs and names the next step.
  `--online` proves the key and the Claude Code sign-in with one tiny call
  each.
- Answer memory (`data/memory.json`, `memory` command, `apply --fresh`): a
  form that was rehearsed is sent with the answers that were read, without
  asking Claude again. An answer the writer marks as true for any company is
  reused on other forms, and JEV decides whether a differently worded
  question is the same one.
- `applied.csv` at the top of the project folder: only the applications
  that were sent, newest first, under plain column names. `log` prints it,
  `log --json` gives the rows as JSON, `log --open` opens it.
- The demographic yes or no questions can be declined in the profile.
- The README says what is planned: signing in to job sites yourself in the
  tool's window, LinkedIn as a source, and reading sign-in codes from Gmail.

### Changed
- A candidate who may work in the United States is no longer ruled out by
  postings that refuse sponsorship. The rule now reads the profile.
- The writer runs in an empty folder and on the five-minute cache, and
  returns the sheet notes with its answers. Ten forms cost $0.17 of Claude
  at API prices, down from $0.23.
- The writer costs about half as much: the candidate's context is cached by
  the provider, and the sheet notes for a run are written in one call.
- One posting is one job: ids come from the ATS posting id, so the same job
  linked three ways is no longer queued three times.
- The rating's term and graduation questions are worded from the profile. A
  posting that asks for another graduation date ranks lower instead of being
  judged the same as one that fits.
- Selectors always name exactly one element and avoid ids a UI library
  renumbers on each render.
- Placeholder labels ("Select", "Search") are replaced by the question text
  above the control. Ashby's Yes/No buttons and role-based radio rows are
  read.
- Lists too long to show JEV (countries, schools) are asked as a value and
  matched in code. Probabilities of keys that write the same value add up.
- A required salary box gets `preferences.salaryIfRequired`.
- The CSV dates an application by the local day and keeps one row per
  posting. The "What They Do" and "Why You're a Fit" cells are written when
  an application is sent.
- The project and its skills run Claude Code on Sonnet 5.5 at high effort.

### Fixed
- Work-history dates and the "current role" box are filled from the most
  recent job in the profile instead of being guessed. JEV now sees the work
  history, so "how many internships" is counted, not estimated.
- A field that asks the candidate to type their name to sign an agreement is
  never filled, and Claude never picks an interview or assessment slot. Both
  hold the form for a person.
- A group of checkboxes is one question: a required group is answered once
  any box is ticked.
- A careers page with a search box and a language picker is no longer taken
  for an application form. When a careers page shows no form, the board's own
  form for the same posting is opened.
- Only the form's own saves and uploads are tracked. Analytics and widgets
  from other sites no longer slow a fill down or fail an upload.
- The resume is attached before the fields are filled, so a board that parses
  it cannot overwrite the profile's values.
- Pages with a password box are blocked before anything is typed.
- A place written another way ("Edmonton, AB, Canada") is matched only when
  a region or country of the candidate's is named, never on the city alone.
- A control that vanished is a failure, not "not applicable".
- Jobvite and SmartRecruiters postings, and iCIMS behind a careers page, are
  skipped at discovery instead of failing at the form.

### Added (first version)
- Discover pipeline: SimplifyJobs lists, three community Canadian lists,
  Greenhouse, Lever and Ashby board polling, code filters, JEV fit rating,
  ranked queue, sheet-compatible CSV.
- Forms layer: `dumpFields.js`, `fillFields.js`, JEV form mapping, page
  state classification, direct apply URLs for Greenhouse, Lever and Ashby.
- Answer bank and voice guide for free-text answers.
- Claude Code skills: `/discover`, `/apply`, `/profile`.
- Offline test suite with captured blank-form fixtures.
