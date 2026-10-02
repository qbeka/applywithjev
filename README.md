# applywithjev

[![ci](https://github.com/qbeka/applywithjev/actions/workflows/ci.yml/badge.svg)](https://github.com/qbeka/applywithjev/actions/workflows/ci.yml)
[![codeql](https://github.com/qbeka/applywithjev/actions/workflows/codeql.yml/badge.svg)](https://github.com/qbeka/applywithjev/actions/workflows/codeql.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.nvmrc)
[![model: typesafe/jev-1.13](https://img.shields.io/badge/JEV-typesafe%2Fjev--1.13-8A2BE2.svg)](https://openrouter.ai/typesafe/jev-1.13)

Finds software internships and new-grad roles, rates each one against a
candidate, fills the application form in seconds, verifies every value on the
page, submits it, and keeps a CSV of everything. Built for one job seeker;
written so anyone can fork it with their own profile.

Three parts do the work:

| Part | Role |
|---|---|
| [JEV](https://openrouter.ai/typesafe/jev-1.13) (`typesafe/jev-1.13` via OpenRouter) | Every typed decision: is this job a fit, which profile value fills this field, which dropdown option is right, what kind of page is this. Returns probabilities, not prose. About half a second and $0.00003 per call. |
| This CLI (TypeScript, Node 22) | Pulls job boards, filters, calls JEV, keeps the queue and the CSV, and drives its own Chrome window over the DevTools protocol: dump the form, fill it with real input events, attach the resume, read every value back. |
| [Claude Code](https://code.claude.com), run headless on Sonnet 5.5 at high effort | Writes the open questions in the candidate's voice and settles the few fields JEV was unsure of. It gets the facts and the open fields, has no tools, and returns one JSON object. |

A full discover run over about 4,500 postings rates roughly 350 fresh
software roles for six cents. A Greenhouse, Lever or Ashby form is filled and
verified in 2 to 12 seconds; ten forms side by side take about a minute and a
half including the written answers.

## How a run works

```
discover                        apply (per job, forms side by side)
  sources ─┐                      open the form in the runner's Chrome
  simplify │                      dumpFields.js → every field, every dropdown's options
  github   ├→ dedupe → code       mapForm (one JEV call) → fill plan
  boards   │  filters → fetch     fill + attach resume → read every value back
  sheet   ─┘  descriptions →      second look (JEV) at dropdowns that refused a value
            JEV rating →          resolve (Claude) → open questions and unsure fields
            queue.json + CSV      ready? → submit → page-state (JEV) → CSV
```

1. **Discover** (no browser). Reads the SimplifyJobs internship and new-grad
   lists, three community Canadian lists, and polls the Greenhouse, Lever and
   Ashby boards of every company those lists mention. One posting reached by
   several links is one job. Code removes what the candidate would never
   apply to (Workday and other account-walled portals, stale postings,
   non-software titles, US roles that say no sponsorship). JEV answers
   fifteen typed questions per remaining job and code turns them into a
   score and a ranked queue.
2. **Fill.** For each queued job the runner opens the direct form URL,
   serializes every field with `src/forms/dumpFields.js`, reads each
   dropdown's real options, and asks JEV in one call which profile value or
   option fills each field. It writes the values, attaches the resume and
   reads every control back. A value that did not stick is retried with real
   clicks and typing. A dropdown that refused the value gets a second JEV
   look at its closest options.
3. **Resolve.** What is still open (written answers, low-confidence fields,
   values the page refused) goes to Claude with the candidate's facts,
   standing answers and voice guide. Claude answers, or says a required field
   cannot be answered truthfully, in which case the job is set aside for a
   person with the reason.
4. **Submit.** Only a form with every wanted value confirmed on the page and
   no required field empty is submitted, and only when the run was started
   with `--submit`. The page after the click is classified by JEV. A
   validation error, a CAPTCHA or a login is recorded, never guessed past.
5. **Record.** `data/applications.csv` has one row per job considered, in
   the fifteen columns of a common tracking sheet plus the tool's own (fit
   score, JEV confidence, ATS, source, posted date, skip reason).

## What it handles

| Job board | State |
|---|---|
| Greenhouse (hosted, embedded, EU) | Filled through the form's own components. Lazy and paginated dropdowns (school, degree, discipline) are read through their loaders. |
| Ashby | Filled one field at a time, because Ashby saves every field to its server as it changes and drops bursts. Yes/No buttons, school and location search, resume upload with the save confirmed. |
| Lever | Filled, including the location box that only accepts a picked suggestion. Lever shows a CAPTCHA at submit, which the user solves in the window. |
| Rippling, BambooHR | Best effort. Custom widgets are filled where they can be confirmed, and anything unconfirmed keeps the form from being submitted. |
| Jobvite, SmartRecruiters | Skipped at discovery: their forms run over several pages. |
| Workday, iCIMS, Taleo, Oracle, SuccessFactors, sites behind a login | Skipped at discovery. The tool never creates accounts. A login page met during a run teaches the next discover to skip that site. |

## Setup

See `docs/SETUP.md`. In short:

```bash
git clone https://github.com/qbeka/applywithjev && cd applywithjev
npm install
cp .env.example .env                              # add your OpenRouter key
cp data/profile.example.json data/profile.json    # fill in your details
cp data/bank.example.json data/bank.json          # your drafts for common questions
cp data/voice.md data/voice.local.md              # how your answers should sound
cp ~/Downloads/resume.pdf data/resume/resume.pdf
npx tsx src/cli.ts discover                       # builds the queue, no browser needed
npx tsx src/cli.ts apply --dry --count 5          # rehearsal: fill, resolve, submit nothing
npx tsx src/cli.ts apply --count 10 --submit      # the real thing
```

Requires Node 22, Google Chrome, an OpenRouter key, and Claude Code installed
and logged in (for the written answers). The profile, drafts, resume, queue
and CSV are git-ignored.

## Commands

| Command | What it does |
|---|---|
| `discover [--no-boards] [--limit N]` | Build the queue and update the CSV |
| `queue [--all]` | Show queued jobs by score |
| `apply [ids...] [--count N] [--submit] [--dry]` | The whole loop: fill, resolve, verify, and with `--submit` send every form that is ready |
| `fill [ids...] [--count N] [--dry]` | Fill forms with JEV and stop |
| `resolve <ids...>` | Hand the open fields of filled forms to Claude and verify |
| `inspect <id>` | Every field of a filled form as the page shows it now, and the page's own errors |
| `set <id> --values file.json` | Write values you chose into a filled form |
| `submit <ids...>` | Submit ready forms and record the outcome |
| `survey` | Totals over every fill report: fields landed, failed, left open |
| `mark <id> --status ...` | Record an outcome by hand |
| `status` | Totals and skip reasons |
| `answer-context`, `map-form`, `page-state`, `next` | The pieces, for driving a browser yourself |

Run any of them with `npx tsx src/cli.ts <command>`. Inside Claude Code,
`/discover`, `/apply` and `/profile` do the same with a person in the loop.

## Making it yours

Everything about the candidate is data, and none of it is in git:

- `data/profile.json`: facts, education, work authorization, demographics,
  preferences, and `answers`, the standing answers to questions that recur
  (which area of engineering, relocation, notice period, text-message
  consent, what to do when a posting wants another graduation date). JEV and
  Claude both follow them, so a wrong answer is fixed once, in one place.
- `data/bank.json`: your own starting drafts for the common open questions.
- `data/voice.local.md`: how written answers should sound.
- `src/config.ts`: every tunable. Sources, thresholds, score weights, how
  many forms run side by side, pacing per site, the writer's model.

## Project structure

```
applywithjev/
├── .claude/               settings (Sonnet 5.5, high effort) and the skills: apply, discover, profile
├── src/
│   ├── cli.ts             commander entry point
│   ├── config.ts          every tunable: paths, thresholds, weights, limits, pacing
│   ├── discover.ts        sources → filters → describe → rate → queue
│   ├── jev/               Decisions API client, question builders, zod types
│   ├── profile/           profile schema; the canonical field keys JEV maps onto
│   ├── sources/           simplify, github lists, greenhouse/lever/ashby boards, sheet import
│   ├── jobs/              Job model and posting ids, hard filters, walled sites, JEV rating, queue
│   ├── forms/             dumpFields.js, fillFields.js, pageHelpers.js, the mapper, page state
│   ├── browser/           the DevTools client and the form runner: fill, verify, resolve, submit
│   ├── answers/           answer bank, drafting context, the Claude writer
│   └── log/               the CSV
├── data/                  example profile, example drafts, voice guide; real data git-ignored
├── docs/                  ARCHITECTURE, JEV, SETUP, SOURCES, SAFETY
└── tests/                 vitest, offline, real captured fixtures
```

## Safety

The tool never lies on a form. Work authorization, education and dates come
from the profile and are not adjusted to fit a posting. It never creates
accounts, never solves CAPTCHAs (the window is visible and the user does),
never writes a cover letter, never volunteers a GPA, and never claims a fact
that is not in the profile. It never types into a page that shows a password
box. It submits a form only when every value it meant to enter is confirmed
on the page, and it treats what the page says after the click as the truth.
`docs/SAFETY.md` has the full list, including what leaves your machine.

## Contributing

Issues and pull requests are welcome. Read `CONTRIBUTING.md` first; the
short version is: tests with every change, no personal data in fixtures,
tunables in `src/config.ts`. Security reports go through
`SECURITY.md`, not public issues.

## License

MIT.
