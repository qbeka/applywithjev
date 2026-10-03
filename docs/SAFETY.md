# Safety

*What this tool will not do, how it treats personal data, and what to
check before you publish a fork.*

## Never automated

| Rule | Where it lives |
|---|---|
| Lying on a form. Work authorization, citizenship, education, graduation date and employment dates come from `data/profile.json` and are not changed to fit a posting. | `src/forms/mapForm.ts` resolves authorization per country in code; the `/apply` skill forbids overriding it |
| Claiming a fact that is not in the profile. Free-text answers may use only `facts`, `experience`, `projects`, and the posting. | `data/voice.md`, `src/answers/context.ts`, the skill |
| Creating accounts on careers portals. Workday, iCIMS, Taleo, Oracle, SuccessFactors and Amazon Jobs are filtered out before rating. | `src/jobs/hardFilters.ts` |
| Passing a human check. This covers CAPTCHAs and the code a board emails to confirm a person is applying. The runner's window is visible; the person does it there. The tool reads no email. | `submitJob` records the page as it is; `codes` in `src/cli.ts` shows the form and waits |
| Signing in. A page with a password box is closed, the job is listed in `manual.csv`, and the site is skipped from then on. No password is stored or typed. | `fillJob` in `src/browser/formRunner.ts`, `outcomeOf` in `src/run/outcome.ts` |
| Signing a contract. A form that asks the candidate to type their name under an agreement, or to tick that they are bound by one, is set aside for them. | `SIGNATURE_LABEL` in `src/forms/mapForm.ts`, the writer's rules in `src/answers/resolve.ts` |
| Submitting a form it has not verified. Every wanted value must be read back from the page and no required field may be empty. | `isReady`, `submitJob` in `src/browser/formRunner.ts` |
| Calling an application sent because the button was clicked. The page after the click is classified, and only a confirmation counts. | `submitJob`, `decidePageState` |
| Paying for anything, or entering payment details. | The skill |
| Writing cover letters or volunteering a GPA. A required cover letter skips the job; a required GPA field gets the real number. | `src/profile/fieldKeys.ts`, `planField` |
| Supplying references. A posting that requires them is skipped and logged. | `src/jobs/rate.ts`, the skill |
| Clicking "Apply with LinkedIn" or resume-autofill helpers that would overwrite the plan. | `mapForm` skips autofill inputs; the skill |
| Submitting without being told to. `apply` fills and verifies; only `--submit` or `submit` sends. | `src/cli.ts`, the skill |

The user can still misrepresent themselves by putting false data in the
profile. The tool makes that the only way.

## Personal data

- The profile, resume, queue, both CSV files, the answer memory, HTTP cache
  and run logs are git-ignored (`.gitignore`). `data/profile.example.json`
  is fictional.
- The answer memory (`data/memory.json`) holds answers Claude wrote for you
  and the questions they answered. It never leaves the machine.
  `npx tsx src/cli.ts memory --clear` empties it.
- The OpenRouter key is read from `.env` only. Error bodies are redacted
  before they are printed (`src/jev/client.ts`).
- What leaves the machine: job text and the profile's facts go to
  OpenRouter (JEV) on every rating and form-mapping call; the facts, the
  posting and the open questions go to Anthropic through your own Claude Code
  login when a form has fields left for Claude; the form values go to the
  employer's ATS; nothing goes anywhere else. There is no telemetry.
- Some boards save each field to their server as it is typed, before
  anything is submitted. Ashby does. A rehearsal (`--dry`) on such a board
  therefore sends the values to that board as an unsubmitted draft. It is not
  an application and the employer is not notified, but it is not nothing.
- A cookie banner is touched only when it covers the Submit button, and it
  is answered with its most private choice (necessary only, or reject).
  The tool never clicks "accept all".
- The runner's Chrome profile lives in `data/runs/chrome-profile`, apart
  from your own browser, with no saved logins. Its cookies, cache and site
  data are cleared between runs after every `RUN.clearBrowsingEvery`
  applications, never while a form is open.
- JEV usage is appended to `data/runs/jev-usage.jsonl` (ids, token counts,
  cost; no content).
- What the tool learns about sites (`data/knowledge.json`) holds host names,
  kinds of controls, counts, and reasons with every quoted value taken out.
  It leaves the machine only if you run `knowledge --share` and commit the
  file it writes.

## Terms of service

Automated form submission may be against the terms of a given job board
or ATS. The tool uses a browser on the user's own machine and their own
identity, submits one application per posting, paces itself per site, and
does not try to look like anything it is not: no stealth flags, no CAPTCHA
solving, no account creation. Read the terms of the sites you use and decide
for yourself.

## Before open-sourcing a fork

```bash
git status --ignored | grep -E "data/|applied.csv|manual.csv"   # profile.json, bank.json, voice.local.md, memory.json, knowledge.json, resume, the csv files, queue, runs must be ignored
git log -p | grep -i -E "sk-or-v1-|@gmail|phone" # nothing should match
npm audit --omit=dev
```

Replace the seed company list in `src/sources/companies.ts` if it does not
match your market, and rewrite `data/voice.md` in your own words.
