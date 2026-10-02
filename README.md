# applywithjev

[![ci](https://github.com/qbeka/applywithjev/actions/workflows/ci.yml/badge.svg)](https://github.com/qbeka/applywithjev/actions/workflows/ci.yml)
[![codeql](https://github.com/qbeka/applywithjev/actions/workflows/codeql.yml/badge.svg)](https://github.com/qbeka/applywithjev/actions/workflows/codeql.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.nvmrc)
[![model: typesafe/jev-1.13](https://img.shields.io/badge/JEV-typesafe%2Fjev--1.13-8A2BE2.svg)](https://openrouter.ai/typesafe/jev-1.13)

This tool finds software internships and new-grad jobs, fills in the
application forms for you, checks every answer on the page, and sends the
applications you approve.

You stay in charge. The tool sends nothing until you tell it to, and it
never writes anything about you that is not in your own profile.

## What the tool does

1. **Finds jobs.** It reads public job lists and company job boards, removes
   the jobs you could not or would not apply to, and ranks the rest for you.
2. **Fills each form.** It opens the form in a Chrome window you can watch
   and fills it in a few seconds.
3. **Checks its work.** It reads every answer back from the page. If an
   answer did not go in, it tries again. If it still cannot confirm the
   answer, it stops and tells you which one.
4. **Sends the form, if you asked it to.** It then reads the page that comes
   back. It records the job as applied only when that page confirms it.
5. **Keeps a record.** Every job it looked at is one row in a spreadsheet
   file, with what happened and why.

## Is this tool for you?

It is for you if you are applying to many software jobs and you want to stop
typing the same answers into every form.

You need:

- a Mac with Google Chrome
- [Node.js](https://nodejs.org) version 22 or newer
- an [OpenRouter](https://openrouter.ai/keys) account with a few dollars of
  credit
- [Claude Code](https://code.claude.com), installed and signed in
- your resume as a PDF

You also need about 20 minutes to describe yourself to the tool the first
time. See [Set it up](#set-it-up).

## What it costs

Two services do the thinking, and you pay each one separately.

- **JEV** answers the questions that have a fixed set of answers, such as
  "which of my details goes in this box?" You pay for it through your
  OpenRouter key.
- **Claude Code** writes the answers that need sentences, such as "Why do
  you want to work here?" It runs on the Sonnet 5.5 model at high effort.
  If you have a Claude subscription, these calls use your plan and you get
  no separate bill. The dollar figures below are what the same calls cost
  at API prices.

We measured 10 application forms on 2 October 2026:

| Step | Service | Calls | Tokens in | Tokens out | Cost |
|---|---|---:|---:|---:|---:|
| Decide what goes in each field | JEV | 12 | 284,436 | 82,673 | $0.012 |
| Read the page after sending | JEV | 10 | about 10,000 | about 800 | $0.001 |
| Write the open answers | Claude Code | 6 | 78,931 | 4,408 | $0.164 |
| Write two notes per job for your record | Claude Code | 1 | 9,668 | 2,995 | $0.069 |
| **Total for 10 applications** | | | | | **about $0.25** |

That is about 2.5 cents for each application. JEV is about one twentieth of
the total.

Three things change the total:

- **Finding jobs costs about 6 cents each time you run it.** That run rates
  about 350 jobs.
- **Forms with more open questions cost more.** Four of the 10 forms had no
  open question and needed no Claude call at all.
- **The first form of a run costs 3 to 4 cents more.** Claude stores your
  profile on the first call and reuses it for the next hour at a tenth of
  the price.

A larger rehearsal gave the same picture. Filling 51 forms cost $0.06 for
JEV and $0.84 for Claude, which is about 1.8 cents for each form before the
notes.

To see what you have spent, run `npx tsx src/cli.ts cost`. Every run that
fills forms also prints its own cost at the end.

## How well it works

We rehearsed every form in the queue on the three job boards the tool
supports best: Greenhouse, Ashby and Lever. A rehearsal fills the form and
sends nothing.

| Measured on 2 October 2026 | Result |
|---|---|
| Forms in the queue | 53 |
| Forms opened (2 jobs had closed) | 51 |
| Answers the tool meant to enter | 1,002 |
| Answers confirmed on the page | 1,000 (99.8%) |
| Forms ready to send with no help | 45 of 51 |
| Forms the tool held for you, with the reason | 4 |
| Forms with an answer the tool could not confirm | 2 |
| Time to fill one form | about 7 seconds |
| Time for all 53 forms, with the written answers | about 5 minutes |

We also read every answer in an earlier rehearsal, one by one. That found
seven wrong answers in about 500. Each one pointed to a cause, such as a
checkbox named after the option above it, and each cause is now fixed and
covered by a test. A rehearsal shows you every answer before anything is
sent, so read it the first time you use the tool.

A form is "ready" only when every answer is confirmed and no required
question is empty. The tool will not send any other form.

The tool holds a form for you when a required question has no true answer
in your profile, or when the answer is yours to give. Examples from the
rehearsal: a form that asks you to rate a skill you never listed, a form
that asks you to type your name to sign an agreement, and a form that asks
you to pick a date for a test.

## Set it up

1. Get the code and install it.

   ```bash
   git clone https://github.com/qbeka/applywithjev && cd applywithjev
   npm install
   ```

2. Add your OpenRouter key. Copy the example file, then open `.env` and
   paste your key after `OPENROUTER_API_KEY=`.

   ```bash
   cp .env.example .env
   ```

3. Describe yourself. Copy the three example files, then edit each copy.

   ```bash
   cp data/profile.example.json data/profile.json
   cp data/bank.example.json data/bank.json
   cp data/voice.md data/voice.local.md
   ```

   | File | What you put in it |
   |---|---|
   | `data/profile.json` | Your details, education, work history, where you may work, and how you want common questions answered |
   | `data/bank.json` | Your own first drafts for common open questions |
   | `data/voice.local.md` | How your written answers should sound |

4. Add your resume.

   ```bash
   cp ~/Downloads/resume.pdf data/resume/resume.pdf
   ```

   Then set `resume.path` in `data/profile.json` to the full path of that
   file.

5. Check your profile. This command prints your details back to you. If
   something is missing, it names the field.

   ```bash
   npx tsx src/cli.ts answer-context --question "tell us about yourself"
   ```

[docs/SETUP.md](docs/SETUP.md) explains each step in more detail and lists
fixes for common problems.

## Apply to jobs

1. **Find jobs.** This takes about a minute and does not open a browser.

   ```bash
   npx tsx src/cli.ts discover
   ```

2. **Rehearse.** The tool fills five forms, sends nothing, and closes them.
   Read the output. Each line shows one question and the answer the page
   holds.

   ```bash
   npx tsx src/cli.ts apply --dry --count 5
   ```

   If an answer is wrong, correct your profile and rehearse again.

3. **Apply.** Choose one of two ways.

   Fill the forms and look at them before anything is sent:

   ```bash
   npx tsx src/cli.ts apply --count 5
   npx tsx src/cli.ts submit <job id> <job id>
   ```

   Or fill and send in one step:

   ```bash
   npx tsx src/cli.ts apply --count 10 --submit
   ```

4. **Check the result.** `status` gives you the totals.
   `data/applications.csv` is the full record, and you can open it in any
   spreadsheet program.

   ```bash
   npx tsx src/cli.ts status
   ```

Stay at your computer while the tool runs. Some forms show a "prove you are
human" test or email you a code. Only you can do those. Do them in the
tool's Chrome window, then run `submit` for that job again.

If you use Claude Code, you can type `/discover`, `/apply` and `/profile`
instead. They run the same steps and help you with any form the tool held.

## What the tool will not do

- **It will not lie.** Your right to work, your education and your dates
  come from your profile. The tool does not change them to suit a job.
- **It will not invent facts.** Written answers use only what your profile
  says.
- **It will not send a form it has not checked.** Every answer must be
  confirmed on the page first.
- **It will not send anything unless you ask.** Sending needs `--submit` or
  the `submit` command.
- **It will not sign for you.** If a form asks you to type your name to
  agree to a contract, the tool leaves it for you.
- **It will not choose a date for you.** If a form asks you to pick an
  interview or test slot, the tool leaves it for you.
- **It will not create accounts or type into a login page.**
- **It will not solve "prove you are human" tests.**
- **It will not write a cover letter or give references.** It skips jobs
  that require them.
- **It will not give your GPA** unless the form cannot be sent without it.

[docs/SAFETY.md](docs/SAFETY.md) has the full list and shows where each rule
lives in the code.

## Which job boards work

| Job board | What to expect |
|---|---|
| Greenhouse | Works well. |
| Ashby | Works well. The tool fills these forms one field at a time, because Ashby saves each field as you type. |
| Lever | Works well. Lever shows a "prove you are human" test when you send, which you do yourself. |
| Rippling, BambooHR | Works in part. The tool fills what it can confirm and holds the form if anything is uncertain. |
| Jobvite, SmartRecruiters | Not supported yet. Their forms run over several pages. The tool skips these jobs when it finds jobs. |
| Workday, iCIMS, Taleo, Oracle, and any site that needs a login | Not supported. The tool skips these jobs. If it meets a login page during a run, it remembers that site and skips it next time. |

## Where your information goes

- Your profile, your drafts, your resume and your record of applications
  stay on your computer. Git ignores all of them, so you cannot commit them
  by accident.
- The job text and the facts in your profile go to OpenRouter when JEV rates
  a job or maps a form.
- The job text, your facts and the open questions go to Anthropic, through
  your own Claude Code sign-in, when a form has questions for Claude.
- Your answers go to the employer's job board.
- Nothing goes anywhere else. The tool collects no usage data.

One thing to know before you rehearse: some job boards save each answer as
it is typed, before you send the form. Ashby does this. A rehearsal on such
a board leaves an unsent draft on that board. The employer is not told, and
it is not an application.

## Make it yours

Everything about you is in data files, not in the code.

- **Standing answers.** The `answers` list in `data/profile.json` says how
  you want recurring questions answered. For example: which area of
  engineering you prefer, whether you will relocate, and whether you agree
  to text messages. JEV and Claude both follow this list. If the tool gives
  a wrong answer, you fix it once, here.
- **Your drafts.** `data/bank.json` holds your starting draft for each
  common open question.
- **Your voice.** `data/voice.local.md` tells Claude how you write.
- **Settings.** `src/config.ts` holds every setting in one place: the job
  lists, the scoring, how many forms run at once, how fast the tool works on
  each site, and which Claude model writes.

## Commands

Run each command as `npx tsx src/cli.ts <command>`.

| Command | What it does |
|---|---|
| `discover` | Finds and ranks jobs |
| `queue` | Lists the ranked jobs |
| `apply [ids] [--count N] [--submit] [--dry]` | Fills, checks and, with `--submit`, sends |
| `fill [ids] [--count N] [--dry]` | Fills forms and stops |
| `resolve <ids>` | Asks Claude to answer what is still open on filled forms |
| `inspect <id>` | Shows what a filled form holds now, and any errors on the page |
| `set <id> --values file.json` | Writes answers you chose into a filled form |
| `submit <ids>` | Sends forms that are ready |
| `status` | Shows totals and the reasons jobs were skipped |
| `cost [--since time]` | Shows what you have spent on JEV and Claude |
| `survey` | Shows how well recent fills went |
| `mark <id> --status ...` | Records an outcome by hand |

## How it works

Three parts share the work.

| Part | Its job |
|---|---|
| [JEV](https://openrouter.ai/typesafe/jev-1.13) | Makes every choice that has a fixed set of answers. It returns probabilities, not text. One call takes about half a second. |
| This program | Finds jobs, applies the rules, drives Chrome, and checks every answer on the page. |
| [Claude Code](https://code.claude.com) | Writes the answers that need sentences. It also decides the few fields JEV was unsure about. It gets your facts and the open questions, and it has no other tools. |

The rule is simple. If a question has a fixed set of answers, JEV answers
it. If it needs a sentence, Claude writes it. If it is a rule, the code
enforces it.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes each step.
[docs/JEV.md](docs/JEV.md) explains how the tool asks JEV its questions.
[docs/SOURCES.md](docs/SOURCES.md) lists where the jobs come from.

## Get help or contribute

- Something went wrong? See the fixes in [docs/SETUP.md](docs/SETUP.md),
  then open an issue.
- A form was filled wrongly? Open a "wrong field mapping" issue with the
  link to the job. Do not include your personal details.
- Want to change the code? Read [CONTRIBUTING.md](CONTRIBUTING.md) first.
- Found a security problem? Follow [SECURITY.md](SECURITY.md). Do not open a
  public issue.

## License

MIT. See [LICENSE](LICENSE).
