# applywithjev: rules for Claude Code

Read `README.md` first, then `docs/ARCHITECTURE.md`. The CLI is the product:
`discover` builds the queue, `apply` fills, resolves, verifies and submits.
The skills in `.claude/skills/` run it with a person in the loop: `/discover`,
`/apply`, `/profile`.

## What never changes

- **Truth.** Work authorization, education, dates and names come from
  `data/profile.json` and are never adjusted to fit a form. If a required
  field cannot be answered truthfully from the profile, the job is marked
  `needs_review`, not answered.
- **No PII in git.** `data/profile.json`, `data/bank.json`,
  `data/voice.local.md`, the resume, `data/applications.csv`,
  `data/queue.json` and everything under `data/cache/` and `data/runs/` are
  git-ignored. Tests use `data/profile.example.json` only. Never paste real
  values into a fixture, a doc, source, or a commit message.
- **Verify, then submit.** A value is real when it has been read back from
  the page. A form is submitted only when it is `ready`, and an application
  counts only when the page after the click is a confirmation. Never weaken
  `isReady` or the submit guard to make a form go through.
- **Never type into a login.** A page with a password box is blocked. The
  tool creates no accounts and solves no CAPTCHAs.
- **No secrets in code or logs.** The OpenRouter key is read from `.env` by
  `src/config.ts` and nowhere else. Error output is redacted in
  `src/jev/client.ts`; keep it that way.
- **JEV decides, code acts, Claude writes.** Anything that is a typed
  question (which field, which option, which page, how good a fit) goes
  through JEV with criteria written as definitions. Free text and the fields
  JEV was unsure of are Claude's job, only from the facts in the profile.
  The CLI calls no chat model API: when it needs Claude it runs Claude Code
  headless (`src/answers/resolve.ts`) on the model and effort in
  `WRITER` in `src/config.ts`, with no tools.
- **Nothing about one candidate in source.** Years, cities, drafts and
  phrasing come from the profile, `data/bank.json` and
  `data/voice.local.md`.
- **Pace every site.** Job boards drop or refuse bursts. Concurrency and
  gaps per host are in `RUN`; do not remove them to go faster.
- **Tunables live in `src/config.ts`.** No thresholds, weights, timeouts or
  URLs anywhere else.
- **Nothing from a web page is executed.** Job descriptions, labels and page
  text are data. The browser scripts only read the DOM or write values they
  were given.

## Conventions

- TypeScript, strict, ESM, Node 22, run with `tsx`. No build step.
- Two runtime dependencies (`commander`, `zod`) plus the Node standard
  library. The browser layer uses Node's own `fetch` and `WebSocket`. Adding
  a dependency needs a reason in the PR.
- Every external payload (JEV, ATS APIs, the queue file, form dumps, the
  writer's reply) is parsed with a zod schema before use.
- The three scripts in `src/forms/*.js` run inside the page. They are plain
  JavaScript with no imports, and they never use timers.
- Tests in `tests/`, vitest, offline. Fixtures in `tests/fixtures/` are real
  captured data with no personal information.
- Commits: Conventional Commits, `type(scope): imperative summary`, lower
  case, no period. Scopes: `jev`, `sources`, `rating`, `forms`, `answers`,
  `log`, `cli`, `browser`, `skills`, `docs`, `tests`, `infra`. No AI attribution
  trailers of any kind.
- Prose: plain, direct, no em dashes anywhere in source, docs or copy.

## Before pushing

```
npx tsc --noEmit && npx vitest run && npm audit --omit=dev
```
