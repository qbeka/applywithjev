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

Claude runs on your own Claude subscription, through Claude Code, or on
your own Claude API key. The only separate bill is JEV, through OpenRouter:
118 applications cost $1.43 in our own use, about 1.2 cents each. See
[What it costs](#what-it-costs).

## Start in three steps

You need a Mac with Google Chrome, [Node.js](https://nodejs.org) 22 or
newer, and [Claude Code](https://code.claude.com), signed in. (You can
also run the commands without Claude Code, on a Claude API key. See
[Claude Code or the Claude API](#claude-code-or-the-claude-api).)

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
   `applied.csv`. Every job it had to leave for you is one row in
   `manual.csv`, with the reason and the link. See
   [Find your applications](#find-your-applications).
6. **Learns.** After each form it notes how that site's controls took
   their values, so the next form there goes faster and fails less. See
   [How the tool learns](#how-the-tool-learns).

## What it costs

Two services do the thinking.

- **JEV** answers the questions that have a fixed set of answers, such as
  "which of my details goes in this box?" and "how good a fit is this
  job?" You pay for it through your OpenRouter key. **This is the only
  separate bill.**
- **Claude** writes the answers that need sentences, such as "Why do you
  want to work here?" It runs on the Sonnet 5.5 model at high effort,
  through Claude Code on your own Claude subscription, so there is no
  separate bill for it. If you would rather use a Claude API key, you can,
  and then those calls are billed to that key. See
  [Claude Code or the Claude API](#claude-code-or-the-claude-api).

### What JEV cost us

Measured on our own use from 1 to 2 October 2026: 118 applications sent,
255 form fills counting rehearsals and retries, and 4 searches that rated
2,182 postings.

| Step | Calls | Cost |
|---|---:|---:|
| Rating postings in 4 searches | 2,182 | $0.35 |
| Deciding what goes in each field | 1,197 | $1.06 |
| Reading the page after Submit, matching remembered answers | 456 | $0.02 |
| **Total for 118 applications** | | **$1.43** |

That is about 1.2 cents per application with the searches included, and
0.9 cents per application for the filling alone. Five dollars of OpenRouter
credit pays for about 400 applications.

What changes these numbers:

- **Forms with more fields cost more to map.** A long form is one JEV call
  of a few thousand tokens; a short one is a fraction of a cent.
- **A rehearsal costs the same as a real fill**, except the "read the page
  after Submit" step, which only a real application reaches.
- **A second search on the same day costs close to nothing**, because a
  posting that has not changed keeps its rating.
- **Claude calls count toward your subscription's usage allowance.** On
  an API key, `cost` shows what they cost instead.

To see what you have spent, run `npx tsx src/cli.ts cost`. Every run that
fills forms also prints its own cost at the end.

### How the tool keeps the cost down

- **It remembers answers.** Every answer Claude writes is kept on your
  computer. When you rehearse a form and then send it, the tool reuses the
  answers you read in the rehearsal and does not ask Claude again. We ran
  the same 10 forms a second time: Claude was asked about 1 form instead of
  6.
- **It reuses an answer on another company's form only when that is safe.**
  Claude marks an answer as reusable only if it would be true for any
  company. JEV then checks that the new question asks for the same thing.
  Most open questions name the company, so expect this to save a little,
  not a lot: in our test, 1 answer in 8 was reusable.
- **It forgets when you change your profile.** A remembered answer is used
  only while your profile, your drafts and your voice guide are unchanged.
  A corrected fact is never overruled by an old answer.
- **It does not ask JEV the same thing twice.** A posting that has not
  changed keeps its rating from the last search, and a form that has not
  changed keeps its field mapping. A second search on the same day costs
  close to nothing.
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
question is empty. The tool will not send any other form. Just before it
sends, it reads the whole page once more, and any required question that
is empty stops it. One case does not hold a form: one or two optional
questions the tool could not answer are left empty, and the report says so.

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
| Greenhouse | Works well, until Greenhouse asks for proof that a person is applying. After several applications in a short time it emails you a code on every form. The tool leaves the first such form open for you and keeps the rest of that day's Greenhouse jobs in the queue. See [Codes and checks that are yours](#codes-and-checks-that-are-yours). |
| Ashby | Works well. Ashby saves each field as you type, so the tool fills these forms one field at a time, and one form at a time. |
| Lever | Works well. |
| Rippling, Workable | Works. Tested on a few forms each. |
| BambooHR | Works, up to its "confirm you are not a robot" check after Submit. The tool fills the form, clicks Submit, and leaves the form open for you to pass the check. See [Codes and checks that are yours](#codes-and-checks-that-are-yours). |
| Jobvite, Tesla, and other forms that run over several pages | Works. The tool fills a page, checks it, clicks the form's own Next, and fills the next page, up to 8 pages. |
| SmartRecruiters | Not supported yet. The tool cannot read its form. It skips these jobs. |
| Workday, iCIMS, Taleo, Oracle, SuccessFactors, Amazon, LinkedIn, and any site that wants a sign-in | The tool does not sign in anywhere. It skips these jobs. If it meets a sign-in page during a run, it closes the page, puts the job on your by-hand list, and skips that site from then on. |

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
- calendars that cannot be typed into: the tool opens the calendar, turns
  to the month, and clicks the day
- phone numbers with a country picker
- consent boxes
- questions that only appear once another is answered: the tool reads the
  page again after it fills, and answers what has appeared
- a cookie banner that covers the Submit button: the tool picks the banner's
  most private choice (necessary cookies only, or reject) and never
  "accept all"

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

The tool does not send a form, closes it, and puts the job on your by-hand
list with the reason when:

- the site wants a sign-in or an account
- the form asks you to sign: to type your name under an NDA or another
  contract, or to tick that you agree to be bound by one
- a required question has no true answer in your profile, such as a
  specific incident it does not record, a rating of a skill you never
  listed, or an address in a country you do not live in
- the form asks you to pick a date or a time for an interview or a test
- the form requires a transcript and your profile has none
- the form requires a pay figure as a number and your profile gives none

It leaves the filled form open for you when the site emails you a code or
shows a "prove you are human" test after you send. On 2 October 2026
Greenhouse asked for a code on 7 of 13 forms sent within a few minutes.

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

Stay near your computer while the tool runs. Some forms show a "prove you
are not a robot" test or email you a code. Only you can do those.

### Codes and checks that are yours

After several applications in a short time, Greenhouse asks for proof that
a person is applying. It emails you an 8-character code and waits. BambooHR
shows a "confirm you are not a robot" check after Submit. The tool does not
read a code, does not type it, and does not pass a robot check. Those steps
are yours.

The tool makes them quick. Run:

```bash
npx tsx src/cli.ts codes
```

It brings each waiting form to the front, one at a time. You type the code
from your email, or pass the check, and click Submit. The tool sees the
confirmation, records the application and moves to the next form. Each one
takes a few seconds.

Once a site has asked for a code or a check, the tool sends it nothing more
that day. The site's other jobs stay in the queue, and a later run picks
them up.

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

### Jobs left for you

`manual.csv`, also at the top of the project folder, lists the jobs the
tool opened and could not finish. Each row has the company, the role, the
reason, and the link, best fit first. Apply to these by hand if you want
them.

```bash
npx tsx src/cli.ts log --manual
```

### Take-home assignments

Some companies ask for a take-home assignment next to the application. The
tool sends the application anyway and lists the assignment in
`takehome.csv`, also at the top of the project folder: the company, the
role, the assignment's link, and what the form said about it. Do these by
hand; the company will only read your application once it has the
assignment.

### Every job considered

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
- **It will not sign in anywhere, and it will not create accounts.** A job
  behind a sign-in goes on your by-hand list.
- **It will not pass a "prove you are human" test for you.** That covers
  picture puzzles and the codes a board emails you.
- **It will not read your email.**
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
  your own Claude Code sign-in or your own Claude API key, when a form has
  questions for Claude.
- Your answers go to the employer's job board.
- What the tool learns about sites stays on your computer unless you choose
  to share it. See [How the tool learns](#how-the-tool-learns).
- Nothing goes anywhere else. The tool collects no usage data.

One thing to know before you rehearse: some job boards save each answer as
it is typed, before you send the form. Ashby does this. A rehearsal on such
a board leaves an unsent draft on that board. The employer is not told, and
it is not an application.

## How the tool learns

The tool does not train a model. It keeps notes, and it reads them before
it acts. There are three kinds.

| What it keeps | Where | What it is for |
|---|---|---|
| **Site notes** | `knowledge/sites.json` in the repository, and `data/knowledge.json` on your computer | How each site's forms behave |
| **Answer memory** | `data/memory.json` | Answers Claude wrote for you, so the same question is not paid for twice |
| **JEV's earlier answers** | `data/cache/` | Ratings of postings and field mappings of forms that have not changed |

### Site notes

After every form, the tool writes down what it found out about the site:

- for each kind of control, the way that got a value into it: set from
  script, typed with real keys, clicked, or picked in a calendar
- whether the site wants a sign-in
- how many pages its form has
- whether it emails a code after you send
- which controls it could not set, and why

The next time it meets that site, it starts with the way that worked. A
phone box that ignored a value set from script is typed into at once, with
no failed first try. A site that wanted a sign-in is skipped when jobs are
found. A site that emailed a code gets a longer pause between applications.

To see the notes, and the list of controls the tool has not learned yet:

```bash
npx tsx src/cli.ts knowledge
```

```bash
npx tsx src/cli.ts knowledge --trouble
```

### Share what your runs learned

The notes hold site names, kinds of controls and counts. They hold nothing
about you: no answers, no names, and every quoted value is taken out of a
reason before it is kept.

To add your notes to the copy that ships with the repository:

```bash
npx tsx src/cli.ts knowledge --share
```

Then commit `knowledge/sites.json` and open a pull request. Every person who
does this makes the tool better on the sites they applied to, for everyone.

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

## Claude Code or the Claude API

The tool reaches Claude in one of two ways. Both run the same model and
the same prompts, and everything else works the same.

| | Claude Code (the default) | The Claude API |
|---|---|---|
| What you need | Claude Code installed and signed in | A Claude API key in `.env` as `ANTHROPIC_API_KEY` |
| What it costs | Your Claude subscription's allowance. No separate bill. | Billed to your key at API prices. `cost` shows the amount. |
| The skills `/setup`, `/apply`, `/discover`, `/profile` | Work | Need Claude Code too. Without it, run the commands yourself. |

With a key in `.env`, the tool uses the API. To keep using Claude Code
while a key is present, add `WRITER_BACKEND=claude-code` to `.env`. Run
`npx tsx src/cli.ts doctor --online` to prove either one works.

## Commands

Run each command as `npx tsx src/cli.ts <command>`.

| Command | What it does |
|---|---|
| `doctor [--online]` | Checks your setup and names the next step |
| `discover [--max-age days]` | Finds and ranks jobs. `--max-age` also takes older postings, for one search |
| `queue` | Lists the ranked jobs |
| `apply [ids] [--count N] [--submit] [--dry] [--fresh]` | Fills each form, page by page, checks every answer and, with `--submit`, sends each form the moment it is ready. `--dry` is a rehearsal. `--fresh` ignores remembered answers |
| `fill [ids] [--count N] [--dry]` | Fills the first page of each form and stops |
| `resolve <ids>` | Answers what is still open on filled forms |
| `submit <ids>` | Sends forms that are ready |
| `codes` | Shows each form that is waiting for you (an emailed code, or a robot check), one at a time, and records it once you have sent it |
| `check <ids>` | Reads what each form's tab shows now, without clicking, and records the job as applied if it is a confirmation |
| `inspect <id>` | Shows what a filled form holds now, and any errors on the page |
| `set <id> --values file.json` | Writes answers you chose into a filled form |
| `log [--manual] [--all] [--json] [--open]` | Lists your applications, or with `--manual` the jobs left for you |
| `status` | Shows totals and the reasons jobs were skipped |
| `cost [--since time]` | Shows what you have spent on JEV, and on Claude when you use an API key |
| `knowledge [--trouble] [--share]` | Shows what the tool has learned about sites, or shares it |
| `memory [--forget text] [--clear]` | Shows or clears the answers the tool remembers |
| `survey` | Shows how well recent fills went |
| `mark <id> --status ...` | Records an outcome by hand |

## How it works

Three parts share the work.

| Part | Its job |
|---|---|
| [JEV](https://openrouter.ai/typesafe/jev-1.13) | Makes every choice that has a fixed set of answers. It returns probabilities, not text. One call takes about half a second. |
| This program | Finds jobs, applies the rules, drives Chrome, walks each form page by page, checks every answer on the page, and keeps its notes. |
| [Claude](https://claude.com), through Claude Code or the Claude API | Writes the answers that need sentences. It also decides the few fields JEV was unsure about. It gets your facts and the open questions, and it has no other tools. |

The rule is simple. If a question has a fixed set of answers, JEV answers
it. If it needs a sentence, Claude writes it. If it is a rule, the code
enforces it.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes each step.
[docs/JEV.md](docs/JEV.md) explains how the tool asks JEV its questions.
[docs/SOURCES.md](docs/SOURCES.md) lists where the jobs come from.

## What is planned

None of this is built yet.

- **SmartRecruiters.** Its form is drawn in a way the tool cannot read yet.
- **Windows and Linux.** The tool is tested only on a Mac.

Signing in to job sites is not planned. The tool skips those sites and
lists their jobs for you to do by hand.

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
