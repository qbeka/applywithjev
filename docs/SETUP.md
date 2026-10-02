# Setup (macOS)

*Fifteen minutes the first time. Last verified 2026-10-02.*

## 1. Prerequisites

- **Node 22 or newer**: `node --version`. Install from nodejs.org or `brew install node`.
- **Google Chrome**. The runner starts its own window with its own profile; your everyday Chrome is not touched.
- **Claude Code** installed and signed in with `/login`. The tool runs it headless (`claude -p`) on Sonnet 5.5 at high effort to write the open answers.
- An **OpenRouter** account and key from https://openrouter.ai/keys. Put a few dollars of credit on it; a full run costs cents.

## 2. Clone and install

```bash
git clone https://github.com/qbeka/applywithjev
cd applywithjev
npm install
npx vitest run        # everything should pass offline
```

## 3. The key

```bash
cp .env.example .env
```

Edit `.env` and set `OPENROUTER_API_KEY=sk-or-v1-…`. The file is
git-ignored. If a key has ever been pasted into a chat, an issue, or a
screenshot, rotate it at openrouter.ai/keys first.

## 4. Your profile

```bash
cp data/profile.example.json data/profile.json
```

Fill in every field. The schema is in `src/profile/schema.ts`; the
important choices:

- `education[0].gpa.volunteer`: `false` means the GPA is only entered when a
  form will not submit without it.
- `workAuthorization`: list only the countries where you can work without
  sponsorship. `statement` is used verbatim when a form asks you to explain.
- `demographics`: answer as you want them answered, including "Prefer not
  to say".
- `preferences.salaryExpectation`: leave empty to never volunteer a number.
- `facts`: the only claims Claude may make in a written answer. Keep every
  number exact.
- `summary`: three or four sentences; this is the candidate side of every
  fit rating, so say what you want, where, and when.

Then put your resume at `data/resume/resume.pdf` and set `resume.path` to
its absolute path, for example `/Users/you/applywithjev/data/resume/resume.pdf`.

Check it: `npx tsx src/cli.ts answer-context --question "tell us about yourself"`
prints your facts back; a schema error names the field to fix.

## 5. Your voice, your drafts, your standing answers

```bash
cp data/voice.md data/voice.local.md
cp data/bank.example.json data/bank.json
```

- `data/voice.local.md` is the style guide for every written answer. Edit it
  until a sample answer sounds like you.
- `data/bank.json` holds your starting draft for each common question (why
  this company, a project you are proud of, how you use AI tools). Text in
  braces is left for Claude to write from the posting.
- `answers` in the profile are your standing answers to questions that
  recur: which area of engineering, relocation, notice period, text-message
  consent, what to do when a posting wants another graduation date. JEV and
  Claude both follow them.

All three are git-ignored. Run `/profile` inside Claude Code to do this
interactively.

## 6. Optional: your existing tracker

Export your tracking sheet as CSV (File → Download → CSV) into
`data/imports/`. Rows not marked applied join the queue on the next
discover. The output CSV uses the same first fifteen columns, so it pastes
back into the sheet.

## 7. First discover

```bash
npx tsx src/cli.ts discover
```

About a minute. It prints totals and the top 50. `npx tsx src/cli.ts status`
shows skip reasons. `data/queue.json` and `data/applications.csv` now exist.

## 8. Rehearse, then apply

```bash
npx tsx src/cli.ts apply --dry --count 5
```

A Chrome window opens. Five forms are filled and resolved, nothing is
recorded, nothing is submitted, and the tabs close. Read the output: one line
per field with the value the page shows. Fix anything wrong in the profile
and rehearse again.

```bash
npx tsx src/cli.ts apply --count 5             # fill and verify, leave the forms open to look at
npx tsx src/cli.ts submit <id> <id> ...        # send the ones you are happy with
npx tsx src/cli.ts apply --count 10 --submit   # or do it all in one go
```

Stay at the computer: a CAPTCHA or an email verification code is yours to
handle, in the runner's window. `npx tsx src/cli.ts status` and
`data/applications.csv` show what happened. Inside Claude Code, `/apply`
runs the same loop and deals with what needs a second look.

## Updating

```bash
git pull && npm install
```

Your `data/` files are untouched by updates.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `OPENROUTER_API_KEY is not set` | Create `.env` as in step 3 |
| `No profile at data/profile.json` | Step 4 |
| `Chrome did not start on port 9333` | Install Google Chrome, or set `BROWSER.chromePath` in `src/config.ts` |
| `could not run claude` | Install Claude Code and run `claude` once to log in |
| A form comes back `blocked: no form found` | The page was a login, a closed posting, or a board the runner does not walk yet. The reason is in the CSV |
| A form comes back `filled, not ready` | The reason names the field. Add a standing answer to the profile, or finish it by hand in the window and `submit <id> --force` |
| Forms on one site start failing with `refused` | The site is rate-limiting. Wait a few minutes; add its host to `RUN.gentleHosts` |
| `AWJ_TRACE=1` before any command | Prints step timings and the page's own network writes |
| JEV 429 | The client retries; if it keeps failing, lower `rateConcurrency` in `src/config.ts` |
