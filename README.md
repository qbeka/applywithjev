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

If you have a Claude subscription, the only bill is about 1 cent for every
10 applications. See [What it costs](#what-it-costs).

## Start in three steps

You need a Mac with Google Chrome, [Node.js](https://nodejs.org) 22 or
newer, and [Claude Code](https://code.claude.com), signed in.

1. Get the code and open Claude Code in it.

   ```bash
   git clone https://github.com/qbeka/applywithjev && cd applywithjev && npm install && claude
   ```

2. Type `/setup`.

3. Do what Claude asks. There are four things:

   - Give it your resume as a PDF.
   - Answer its questions. It asks only what your resume does not say:
     where you may work, what you are looking for, and how you want
     common questions answered.
   - Paste one key into a file. Claude opens the file for you. The key
     is from [OpenRouter](https://openrouter.ai/keys) and pays for JEV.
   - Read the three forms it fills as a rehearsal, then say "go".

Setup takes about 20 minutes. Most of that is your answers.

To set up by hand instead, follow [docs/SETUP.md](docs/SETUP.md). To check
your setup at any time, run `npx tsx src/cli.ts doctor`. It lists what is
in place and names the next step.

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
5. **Keeps a record.** Every application you sent is one row in
   `applied.csv`. See [Find your applications](#find-your-applications).

## What it costs

Two services do the thinking.

- **JEV** answers the questions that have a fixed set of answers, such as
  "which of my details goes in this box?" You pay for it through your
  OpenRouter key. **This is the only bill you get if you have a Claude
  subscription.**
- **Claude Code** writes the answers that need sentences, such as "Why do
  you want to work here?" It runs on the Sonnet 5.5 model at high effort.
  With a Claude subscription, these calls use your plan's allowance and you
  get no separate bill. Without a subscription, you pay for them at API
  prices.

### What you pay

| | With a Claude subscription | Paying Claude at API prices |
|---|---:|---:|
| Finding jobs, each time you search | $0.06 to $0.07 | $0.06 to $0.07 |
| 10 applications | about $0.01 | about $0.19 |
| 50 applications | about $0.06 | about $0.93 |
| One search and 50 applications | about $0.13 | about $1.00 |

Five dollars of OpenRouter credit pays for about 70 searches, or for about
4,000 applications.

### How we measured it

We filled 10 application forms on 2 October 2026 and recorded every call.

| Step | Service | Calls | Tokens in | Tokens out | Cost |
|---|---|---:|---:|---:|---:|
| Decide what goes in each field | JEV | 12 | 284,453 | 82,675 | $0.012 |
| Read the page after sending | JEV | 10 | about 11,000 | about 1,500 | under $0.001 |
| Write the open answers | Claude Code | 6 | 72,327 | 6,568 | $0.144 |
| Write two notes per job for your record | Claude Code | 1 | 4,605 | 1,773 | $0.029 |
| **Total for 10 applications** | | | | | **about $0.19** |

The JEV rows add up to about 1 cent. The Claude rows add up to about 17
cents at API prices.

What these numbers leave out, and what changes them:

- **Finding jobs is separate.** One search rated 352 jobs for $0.058 and
  another rated 462 jobs for $0.074. JEV does all of it.
- **Forms with more open questions cost more.** Four of the 10 forms had no
  open question and needed no Claude call at all.
- **The "read the page" row is from real applications.** A rehearsal sends
  nothing, so it never reaches that step.
- **A subscription has a usage allowance.** These calls count toward it.

To see what you have spent, run `npx tsx src/cli.ts cost`. Every run that
fills forms also prints its own cost at the end.

### How the tool keeps the cost down

- **It remembers answers.** Every answer Claude writes is kept on your
  computer. When you rehearse a form and then send it, the tool reuses the
  answers you read in the rehearsal and does not ask Claude again. We ran
  the same 10 forms a second time: Claude was asked about 1 form instead of
  6, and the Claude cost fell from $0.144 to $0.018.
- **It reuses an answer on another company's form only when that is safe.**
  Claude marks an answer as reusable only if it would be true for any
  company. JEV then checks that the new question asks for the same thing.
  Most open questions name the company, so expect this to save a little,
  not a lot: in our test, 1 answer in 8 was reusable.
- **It forgets when you change your profile.** A remembered answer is used
  only while your profile, your drafts and your voice guide are unchanged.
  A corrected fact is never overruled by an old answer.
- **It sends Claude only what Claude needs.** Your profile is sent once per
  run and reused from a cache for the following forms.
- **JEV does everything it can.** On a typical form JEV settles all but one
  or two fields, for about a tenth of a cent.

To see or clear what the tool remembers, run `npx tsx src/cli.ts memory`.

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

"Confirmed" means the answer is on the page. It does not mean the answer
is the right one. To check that, we read every answer in an earlier
rehearsal, one by one. That found seven wrong answers in about 500. Each
one pointed to a cause, such as a checkbox named after the option above it,
and each cause is now fixed. A rehearsal shows you every answer before
anything is sent, so read it the first time you use the tool.

A form is "ready" only when every answer is confirmed and no required
question is empty. The tool will not send any other form. One case does not
hold a form: an optional question the tool could not answer is left empty,
and the report says so.

## What the tool handles

### Where it finds jobs

| Source | What it is |
|---|---|
| [SimplifyJobs/Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships) | The largest public list of software internships. The tool reads the data file behind the list, so it also sees each job's sponsorship and degree flags. |
| [SimplifyJobs/New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions) | The same, for new-grad jobs. |
| [negarprh/Canadian-Tech-Internships-2027](https://github.com/negarprh/Canadian-Tech-Internships-2027) | Internships in Canada. |
| [vanshb03/Summer2027-Internships](https://github.com/vanshb03/Summer2027-Internships) | Internships in the United States and Canada. |
| [michelleokolie/canada-tech-internships-summer-2027](https://github.com/michelleokolie/canada-tech-internships-summer-2027) | Internships in Canada. |
| Company job boards | The tool asks Greenhouse, Lever and Ashby directly for the jobs of every company the lists name, and of 65 more companies. This finds jobs a day or two before the lists do. |
| Your own list | Put a CSV file with a company column and a link column in `data/imports/`. |

On one search, these sources gave 4,748 different jobs. The tool counts a
job once, however many lists link to it.

To add a list or a company, see [docs/SOURCES.md](docs/SOURCES.md).

### Which jobs it keeps

Before it spends anything, the tool removes jobs that:

- need an account to apply
- were posted more than 14 days ago
- are not software jobs, by their title
- have a French title (the tool writes in English only)
- require a master's degree or a doctorate
- are unpaid
- are in the United States and refuse visa sponsorship, if your profile
  says you would need it

JEV then reads each remaining job and answers 15 questions about it. They
cover the level, the term, how well your skills and experience match, where
the job is, and whether it asks for a graduation date that is not yours.
The answers become one score, and the queue is ranked by that score.

The tool does not drop a job only because it asks for another graduation
date. It ranks the job lower and leaves the choice to you.

### Which job boards it can fill

| Job board | What to expect |
|---|---|
| Greenhouse | Works well. After several applications in a short time, Greenhouse emails you a code to confirm that a person is applying. The tool stops there and leaves the form open. You type the code and send the form, then run `check <job id>` to record it. |
| Ashby | Works well. The tool fills these forms one field at a time, because Ashby saves each field as you type. |
| Lever | Works well. Lever shows a "prove you are human" test when you send, which you do yourself. |
| Rippling, Workable | Works. Tested on a few forms each. |
| BambooHR | Works in part. The tool fills what it can confirm and holds the form if anything is uncertain. |
| Tesla and other forms that run over several pages | The tool fills the first page, sees that the form goes on, and stops. See [What is planned](#what-is-planned). |
| Jobvite, SmartRecruiters | Not supported yet. Their forms run over several pages. The tool skips these jobs when it finds jobs. |
| Workday, iCIMS, Taleo, Oracle, SuccessFactors, Amazon, LinkedIn, and any site that needs a sign-in | Not supported yet. The tool skips these jobs. If it meets a sign-in page during a run, it remembers that site and skips it next time. See [What is planned](#what-is-planned). |

### Which parts of a form it fills

- text boxes and long-answer boxes
- dropdown lists, including the kind you type into to search
- long lists that load as you type, such as schools and cities
- Yes and No buttons, and other button groups
- single-choice options and groups of checkboxes
- the resume upload. A box that asks for another file, such as a
  transcript, never gets the resume. It gets your transcript if you added
  one to your profile, and otherwise the form is held
- dates, and dates split into a month box and a year box
- phone numbers with a country picker
- consent boxes

### Which questions it answers

| Kind of question | Where the answer comes from |
|---|---|
| Your name, contact details, address and links | Your profile |
| School, degree, field of study, start and graduation dates | Your profile |
| Jobs you have held, with their dates | Your profile |
| "Are you authorized to work here?" and "Will you need sponsorship?" | Your profile, worked out for the country of each job |
| Gender, ethnicity, veteran status, disability | Your profile. You can decline each one. |
| Relocation, office days, start date, availability | Your standing answers |
| "How did you hear about us?" | Your standing answers |
| Text messages, marketing, keeping your details for later | Your standing answers |
| Pay | Left empty. If the box is required, the words you chose, such as "Negotiable" |
| GPA | Left empty unless the form cannot be sent without it, or you chose to always give it |
| "Why do you want to work here?", "Describe a project", "Which AI tools do you use?" and other open questions | Claude writes them from your facts, your drafts and the job text |

### What it leaves to you

The tool holds the form and tells you why when:

- a required question has no true answer in your profile, such as rating a
  skill you never listed or giving an address in a country you do not live in
- the form asks you to sign, by typing your name under a contract
- the form asks you to pick a date or a time for an interview or a test
- the form includes a quiz or a take-home task
- the site shows a "prove you are human" test or emails you a code. On
  2 October 2026 Greenhouse asked for a code on 7 of 13 forms sent within
  a few minutes

## Apply to jobs

`/setup` takes you through these steps the first time. After that, type
`/discover` and `/apply` in Claude Code, or run the commands yourself.

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
   ```

   ```bash
   npx tsx src/cli.ts submit <job id> <job id>
   ```

   Or fill and send in one step:

   ```bash
   npx tsx src/cli.ts apply --count 10 --submit
   ```

4. **Check the result.**

   ```bash
   npx tsx src/cli.ts log
   ```

Stay at your computer while the tool runs. Some forms show a "prove you are
human" test or email you a code. Only you can do those. Do them in the
tool's Chrome window, then run `submit` for that job again.

## Find your applications

The applications you sent are in **`applied.csv`**, at the top of the
project folder. It has one row for each application, newest first. Open it
in any spreadsheet program, or run:

```bash
npx tsx src/cli.ts log --open
```

| Column | What it holds |
|---|---|
| `applied_on` | The date you applied, as year-month-day |
| `company`, `role`, `location` | The job |
| `job_link` | The link to the posting |
| `work_auth` | What the posting says about visas |
| `term`, `level` | For example "Summer 2027" and "internship" |
| `ats`, `source` | The job board, and the list the job came from |
| `fit_score` | The tool's score for the job, from 0 to 1 |
| `what_they_do` | One sentence about the company |
| `why_fit` | One sentence on why you suit the job |
| `notes` | The reasons behind the score |
| `job_id` | The tool's id for the job, which the commands accept |

The column names never change, so a script can rely on them. For the same
rows as JSON, run `npx tsx src/cli.ts log --json`.

`data/applications.csv` is the full record. It lists every job the tool
looked at, including the ones it skipped, with the reason. Its first 15
columns match a common job-tracking sheet, so you can paste it into one.
To print it, run `npx tsx src/cli.ts log --all`.

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
- **It will not create accounts or type into a sign-in page.**
- **It will not solve "prove you are human" tests.**
- **It will not write a cover letter or give references.** It skips jobs
  that require them.
- **It will not give your GPA** unless the form cannot be sent without it,
  or you chose to always give it.

[docs/SAFETY.md](docs/SAFETY.md) has the full list and shows where each rule
lives in the code.

## Where your information goes

- Your profile, your drafts, your resume, your record of applications and
  the answers the tool remembers stay on your computer. Git ignores all of
  them, so you cannot commit them by accident.
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

Everything about you is in data files, not in the code. `/profile` in
Claude Code changes any of them with you.

- **Standing answers.** The `answers` list in `data/profile.json` says how
  you want recurring questions answered. For example: which area of
  engineering you prefer, whether you will relocate, and whether you agree
  to text messages. JEV and Claude both follow this list. If the tool gives
  a wrong answer, you fix it once, here.
- **Your drafts.** `data/bank.json` holds your starting draft for each
  common open question.
- **Your voice.** `data/voice.local.md` tells Claude how you write.
- **Settings.** `src/config.ts` holds every setting in one place: the job
  lists, the scoring, which places rank highest, how many forms run at
  once, how fast the tool works on each site, which Claude model writes,
  and whether the tool remembers answers.

## Commands

Run each command as `npx tsx src/cli.ts <command>`.

| Command | What it does |
|---|---|
| `doctor [--online]` | Checks your setup and names the next step |
| `discover` | Finds and ranks jobs |
| `queue` | Lists the ranked jobs |
| `apply [ids] [--count N] [--submit] [--dry] [--fresh]` | Fills, checks and, with `--submit`, sends. `--fresh` ignores remembered answers |
| `fill [ids] [--count N] [--dry]` | Fills forms and stops |
| `resolve <ids>` | Answers what is still open on filled forms |
| `inspect <id>` | Shows what a filled form holds now, and any errors on the page |
| `set <id> --values file.json` | Writes answers you chose into a filled form |
| `submit <ids>` | Sends forms that are ready |
| `check <ids>` | Reads what each form's tab shows now, without clicking, and records the job as applied if it is a confirmation. Use it after you finished a form by hand |
| `log [--all] [--json] [--open]` | Lists your applications |
| `status` | Shows totals and the reasons jobs were skipped |
| `cost [--since time]` | Shows what you have spent on JEV and Claude |
| `memory [--forget text] [--clear]` | Shows or clears the answers the tool remembers |
| `survey` | Shows how well recent fills went |
| `mark <id> --status ...` | Records an outcome by hand |

## How it works

Three parts share the work.

| Part | Its job |
|---|---|
| [JEV](https://openrouter.ai/typesafe/jev-1.13) | Makes every choice that has a fixed set of answers. It returns probabilities, not text. One call takes about half a second. |
| This program | Finds jobs, applies the rules, drives Chrome, checks every answer on the page, and remembers answers. |
| [Claude Code](https://code.claude.com) | Writes the answers that need sentences. It also decides the few fields JEV was unsure about. It gets your facts and the open questions, and it has no other tools. |

The rule is simple. If a question has a fixed set of answers, JEV answers
it. If it needs a sentence, Claude writes it. If it is a rule, the code
enforces it.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes each step.
[docs/JEV.md](docs/JEV.md) explains how the tool asks JEV its questions.
[docs/SOURCES.md](docs/SOURCES.md) lists where the jobs come from.

## What is planned

None of this is built yet. Today the tool only fills forms that need no
account, and it skips every site that asks you to sign in.

### Sign in to job sites

Many jobs sit behind a sign-in: LinkedIn, Workday, iCIMS, Taleo, Oracle and
company career sites with their own accounts. On one search, 903 of the
4,454 jobs found were on Workday alone. The plan is one command that opens
a site in the tool's Chrome window so that you can sign in yourself.

- You type your password. The tool never sees it and never types it.
- The tool keeps each sign-in in its own Chrome profile, apart from your
  everyday browser, so you sign in to each site once.
- You can connect as many sites as you like and remove any of them.
- Once a site is connected, the tool can read its jobs and fill its forms
  in the same way it does today, with the same checks.

### LinkedIn

With LinkedIn connected, the tool could read your saved searches and job
alerts as another source of jobs, and fill "Easy Apply" forms. LinkedIn's
terms limit automated use, so this will be slow, opt-in, and off by
default.

### Read sign-in emails from Gmail

Some sites email you a code or a link when you sign in or after you apply.
Today you have to copy that code yourself. The plan is to let the tool read
it for you, if you allow it.

- It will read only the newest message from the site you are signing in to
  or have just applied to.
- It will use the code or the link and nothing else in the message.
- It will not read, send, move or delete any other email.

### Also planned

- **Forms that run over several pages**, such as Jobvite and
  SmartRecruiters.
- **Windows and Linux.** The tool is tested only on a Mac.

## Get help or contribute

- Something went wrong? Run `npx tsx src/cli.ts doctor`, see the fixes in
  [docs/SETUP.md](docs/SETUP.md), then open an issue.
- A form was filled wrongly? Open a "wrong field mapping" issue with the
  link to the job. Do not include your personal details.
- Want to change the code? Read [CONTRIBUTING.md](CONTRIBUTING.md) first.
- Found a security problem? Follow [SECURITY.md](SECURITY.md). Do not open a
  public issue.

## License

MIT. See [LICENSE](LICENSE).
