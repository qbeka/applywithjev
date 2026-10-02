#!/usr/bin/env -S npx tsx
/**
 * applywithjev command line. Claude Code calls these from the apply skill;
 * you can run them by hand too. Every command prints JSON with --json so
 * the output is machine-readable.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadEnv, mailCredentials, DISCOVER, MAIL, PATHS, RUN } from "./config.js";
import { discover } from "./discover.js";
import { JevClient } from "./jev/client.js";
import { applyUrlFor } from "./jobs/normalize.js";
import { loadQueue, nextQueued, saveQueue, sortEntries, updateEntry, QueueStatus, type QueueEntry } from "./jobs/queue.js";
import { appliedRecords, loadRows, saveRows, toRecord, upsertEntry } from "./log/csv.js";
import { loadProfile, type Profile } from "./profile/schema.js";
import { answerContext } from "./answers/context.js";
import { mapForm } from "./forms/mapForm.js";
import { decidePageState } from "./forms/pageState.js";
import { FieldsDump } from "./forms/fields.js";
import { ensureBrowser } from "./browser/cdp.js";
import { checkJob, closeJobTab, fillJob, hasOpenTab, inspect, loadReport, resolveJob, setValues, submitJob, watchForConfirmation, type Fill, type FillReport } from "./browser/formRunner.js";
import { addSite, forgetSite, hostOf as siteHost, loadSites, needsSignIn, saveSites, sitesNeedingSignIn, waitForSignIn } from "./browser/sites.js";
import { Mailbox } from "./mail/imap.js";
import { codeArrived, latestReply, loadInbox, REPLY_LABEL, saveInbox, sortMail, type AppliedJob } from "./mail/inbox.js";
import { hostIs, type Job } from "./jobs/normalize.js";
import { forgetWalledHost, rememberWalledHost } from "./jobs/walled.js";
import { contextFingerprint, logNotes } from "./answers/resolve.js";
import { loadMemory, prune, saveMemory } from "./answers/memory.js";
import { formatCost, loadCost } from "./log/cost.js";
import { formatChecks, isReadyToRun, nextStep, runChecks } from "./doctor.js";
import { limiter, paced, spacer } from "./util/pace.js";

loadEnv();
// Output piped into a command that stops reading early (head, a pager) is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
const program = new Command();
program.name("applywithjev").description("Find and rate software jobs with JEV, fill and check each application form in Chrome, and let Claude Code write what needs writing.").version("0.1.0");

const out = (data: unknown, json: boolean, human: () => void) => (json ? console.log(JSON.stringify(data, null, 2)) : human());

program
  .command("discover")
  .description("Pull every source, filter, rate with JEV, and write data/queue.json and data/applications.csv")
  .option("--no-boards", "skip polling company boards directly")
  .option("--limit <n>", "rate at most n new jobs (for a quick test)", (v) => parseInt(v, 10))
  .option("--json", "print the summary as JSON")
  .action(async (o: { boards: boolean; limit?: number; json?: boolean }) => {
    const profile = loadProfile();
    const jev = new JevClient();
    const { queue, summary } = await discover(profile, jev, {
      boards: o.boards,
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
      log: (l) => console.error(l),
    });
    const top = sortEntries(queue.entries.filter((e) => e.status === "queued")).slice(0, RUN.targetPerRun);
    out({ summary, top: top.map(brief) }, !!o.json, () => {
      console.log(`\n${summary.unique} unique postings, ${summary.preFiltered} removed by code filters, ${summary.rated} rated by JEV.`);
      console.log(`${summary.queued} queued (score ≥ ${DISCOVER.applyThreshold}), ${summary.belowThreshold} below threshold, ${summary.skippedByJev} skipped by JEV.`);
      console.log(`JEV: ${summary.jevCalls} calls, $${summary.jevCostUsd.toFixed(4)}.\n`);
      printTable(top);
    });
  });

program
  .command("queue")
  .description("Show the queue")
  .option("--all", "include skipped and applied entries")
  .option("--limit <n>", "rows to show", (v) => parseInt(v, 10), 50)
  .option("--json")
  .action((o: { all?: boolean; limit: number; json?: boolean }) => {
    const q = loadQueue();
    const entries = sortEntries(o.all ? q.entries : q.entries.filter((e) => e.status === "queued")).slice(0, o.limit);
    out(entries.map(brief), !!o.json, () => printTable(entries));
  });

program
  .command("next")
  .description("Print the best queued job and mark it in progress")
  .option("--peek", "do not change its status")
  .option("--json")
  .action((o: { peek?: boolean; json?: boolean }) => {
    const q = loadQueue();
    const e = nextQueued(q);
    if (!e) {
      out({ done: true }, !!o.json, () => console.log("Queue is empty. Run discover."));
      return;
    }
    if (!o.peek) {
      updateEntry(q, e.job.id, { status: "in_progress", attempts: e.attempts + 1 });
      saveQueue(q);
    }
    const applied = q.entries.filter((x) => x.status === "applied").length;
    const payload = { ...brief(e), applyUrl: applyUrlFor(e.job as { url: string; ats: import("./jobs/normalize.js").Ats }), description: e.job.description ?? "", reviewRequired: applied < RUN.reviewFirst, appliedSoFar: applied };
    out(payload, !!o.json, () => console.log(JSON.stringify(payload, null, 2)));
  });

program
  .command("mark <id>")
  .description("Set a job's status: applied | skipped | failed | blocked | needs_review | queued")
  .requiredOption("--status <status>")
  .option("--reason <text>")
  .option("--notes <text>")
  .option("--what-they-do <text>", "fills the sheet's What They Do column")
  .option("--why-fit <text>", "fills the sheet's Why You're a Fit column")
  .action((id: string, o: { status: string; reason?: string; notes?: string; whatTheyDo?: string; whyFit?: string }) => {
    const status = QueueStatus.parse(o.status);
    const q = loadQueue();
    const e = updateEntry(q, id, {
      status,
      statusReason: o.reason ?? null,
      ...(o.notes ? { notes: o.notes } : {}),
      ...(status === "applied" ? { appliedAt: new Date().toISOString() } : {}),
    });
    saveQueue(q);
    let rows = loadRows();
    rows = upsertEntry(rows, e, {
      ...(o.whatTheyDo ? { "What They Do": o.whatTheyDo } : {}),
      ...(o.whyFit ? { "Why You're a Fit": o.whyFit } : {}),
      ...(o.notes ? { Notes: o.notes } : {}),
    });
    saveRows(rows);
    console.log(`${e.job.company} | ${e.job.title} → ${status}${o.reason ? ` (${o.reason})` : ""}`);
  });

program
  .command("map-form")
  .description("Map a dumped form (from dumpFields.js) to a fill plan with JEV")
  .requiredOption("--fields <file>", "JSON produced by dumpFields.js")
  .requiredOption("--job <id>", "queue entry id, for context")
  .option("--out <file>", "write the plan here as well as printing it")
  .action(async (o: { fields: string; job: string; out?: string }) => {
    const profile = loadProfile();
    const jev = new JevClient();
    const q = loadQueue();
    const entry = q.entries.find((e) => e.job.id === o.job);
    if (!entry) throw new Error(`No queue entry ${o.job}`);
    const dump = FieldsDump.parse(JSON.parse(readFileSync(o.fields, "utf8")));
    const plan = await mapForm(jev, profile, entry.job as unknown as import("./jobs/normalize.js").Job, dump);
    const json = JSON.stringify(plan, null, 2);
    if (o.out) writeFileSync(o.out, json);
    console.log(json);
  });

type RunOptions = { count: number; dry?: boolean; json?: boolean; fresh?: boolean };

/** The jobs a run works on: the given ids, or the best queued ones. A real run marks them in progress; a rehearsal leaves the queue alone. */
function takeJobs(ids: string[], o: RunOptions): QueueEntry[] {
  const q = loadQueue();
  if (ids.length) {
    return ids.map((id) => {
      const e = q.entries.find((x) => x.job.id === id);
      if (!e) throw new Error(`No queue entry ${id}`);
      return e;
    });
  }
  if (o.dry) return sortEntries(q.entries.filter((e) => e.status === "queued")).slice(0, o.count);
  const entries: QueueEntry[] = [];
  for (let i = 0; i < o.count; i++) {
    const e = nextQueued(q);
    if (!e) break;
    updateEntry(q, e.job.id, { status: "in_progress", attempts: e.attempts + 1 });
    entries.push(e);
  }
  saveQueue(q);
  return entries;
}

const blockedReport = (e: QueueEntry, reason: string): FillReport => ({ jobId: e.job.id, company: e.job.company, title: e.job.title, ats: e.job.ats, url: e.job.url, state: "blocked", reason, fields: [], drafts: [], reviews: [], failed: [], leftBlank: [], missingRequired: [], ready: false, seconds: 0, jevCostUsd: 0 });

/** Fills one form. When values did not land, the form is opened and filled once more, and the better of the two results is kept. */
async function fillOne(jev: JevClient, profile: Profile, e: QueueEntry): Promise<FillReport> {
  let best = await fillOnce(jev, profile, e);
  for (let attempt = 1; attempt < RUN.fillAttempts && best.state === "filled" && best.failed.length > 0; attempt++) {
    const again = await fillOnce(jev, profile, e);
    // The tab now holds the second fill, so its report is the one that describes the page, unless it could not be opened at all.
    if (again.state !== "filled") break;
    best = again;
  }
  return best;
}

/** One go at a form, within RUN.fillTimeoutMs. A form that cannot be opened, or never settles, comes back as blocked. */
async function fillOnce(jev: JevClient, profile: Profile, e: QueueEntry): Promise<FillReport> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the form did not finish loading and filling in ${RUN.fillTimeoutMs / 1000}s`)), RUN.fillTimeoutMs);
    });
    const filling = fillJob(jev, profile, e.job as unknown as Job);
    // If the time runs out, the fill is abandoned: its tab is closed below, and whatever it does afterwards is ignored.
    filling.catch(() => undefined);
    return await Promise.race([filling, tooLong]);
  } catch (err) {
    if (err instanceof Error && /did not finish loading/.test(err.message)) {
      abandoned = true;
      await closeJobTab(e.job.id).catch(() => undefined);
    }
    return blockedReport(e, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Set when a fill was abandoned. Its page connection may still be open, so the command ends the process itself when it is done. */
let abandoned = false;
const endIfAbandoned = () => {
  if (abandoned) process.exit(process.exitCode ?? 0);
};

/** Settles what JEV left open on one form: from the answer memory, or by Claude. A writer error leaves the form as it was, not ready. */
async function resolveOne(jev: JevClient, profile: Profile, entry: QueueEntry | null, r: FillReport, fresh: boolean): Promise<FillReport> {
  if (r.state !== "filled" || r.ready) return r;
  try {
    return await resolveJob(profile, entry, r.jobId, { jev, fresh });
  } catch (err) {
    return { ...r, reason: `writer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type PipelineOptions = { submit: boolean; dry: boolean; fresh: boolean; quiet: boolean; fillOnly?: boolean };

/**
 * Each job moves on its own through fill, resolve and submit. Nothing waits for the batch: a form
 * is sent the moment it is ready, and its result is printed and recorded then. Fills run side by
 * side and paced per site, the writer takes a few forms at a time, and submissions go one at a time.
 */
async function pipeline(entries: QueueEntry[], o: PipelineOptions): Promise<{ reports: FillReport[]; sent: string[] }> {
  const profile = loadProfile();
  const jev = new JevClient();
  await ensureBrowser();
  const writer = limiter(RUN.writerConcurrency);
  const reports = new Array<FillReport>(entries.length);
  const sent: string[] = [];
  const after: Promise<void>[] = [];
  await paced(entries, (e) => hostOf(applyUrlFor(e.job as unknown as Job)), async (e) => {
    const filled = await fillOne(jev, profile, e);
    const index = entries.indexOf(e);
    reports[index] = filled;
    // The rest of this job's path does not hold a fill slot: the next form starts filling now.
    after.push(
      (async () => {
        const r = o.fillOnly ? filled : await writer(() => resolveOne(jev, profile, e, filled, o.fresh));
        reports[index] = r;
        if (!o.quiet) printFill(r);
        if (o.dry) return closeJobTab(r.jobId);
        if (o.fillOnly) return;
        if (r.state === "blocked") {
          const rec = record(r.jobId, "blocked", r.reason);
          // A login page teaches the next discover to skip that careers site.
          if (/login or account|no form found, page looks like: (login_required|job_description)/.test(r.reason ?? "")) rememberWalledHost(rec.job.url);
          await closeJobTab(r.jobId);
        } else if (r.resolution?.verdict === "skip" || r.multiPage) {
          record(r.jobId, "skipped", r.multiPage ? "form runs over several pages, not supported yet" : (r.resolution?.reason ?? ""));
          await closeJobTab(r.jobId);
        } else if (!r.ready) {
          record(r.jobId, "needs_review", notReady(r));
        } else if (o.submit) {
          if (await submitAndRecord(jev, r.jobId, false)) sent.push(r.jobId);
        }
      })().catch((err) => console.log(`${e.job.id}  ${err instanceof Error ? err.message : String(err)}`)),
    );
    return filled;
  });
  await Promise.all(after);
  return { reports, sent };
}

/** Records an outcome in the queue and the CSV. */
function record(id: string, status: QueueEntry["status"], reason: string | null, extra: Partial<Record<"What They Do" | "Why You're a Fit" | "Notes", string>> = {}): QueueEntry {
  const q = loadQueue();
  const e = updateEntry(q, id, { status, statusReason: reason, ...(status === "applied" ? { appliedAt: new Date().toISOString() } : {}) });
  saveQueue(q);
  saveRows(upsertEntry(loadRows(), e, extra));
  return e;
}

program
  .command("fill [ids...]")
  .description("Open each job's form in the runner's Chrome window and fill it with JEV. Does not submit.")
  .option("--count <n>", "with no ids: take this many jobs from the top of the queue", (v) => parseInt(v, 10), 1)
  .option("--dry", "a rehearsal: leave the queue untouched and close each tab once it is filled")
  .option("--json")
  .action(async (ids: string[], o: RunOptions) => {
    const { reports } = await pipeline(takeJobs(ids, o), { submit: false, dry: !!o.dry, fresh: false, quiet: !!o.json, fillOnly: true });
    if (o.json) console.log(JSON.stringify(reports, null, 2));
    endIfAbandoned();
  });

program
  .command("resolve <ids...>")
  .description("Settle the fields JEV left open on filled forms: from the answer memory, or by Claude (Sonnet 5.5, high effort). Write the answers in and verify them")
  .option("--fresh", "ignore the answer memory and ask Claude again")
  .action(async (ids: string[], o: { fresh?: boolean }) => {
    const profile = loadProfile();
    const jev = new JevClient();
    const q = loadQueue();
    const writer = limiter(RUN.writerConcurrency);
    await Promise.all(ids.map((id) => writer(async () => printFill(await resolveOne(jev, profile, q.entries.find((e) => e.job.id === id) ?? null, loadReport(id), !!o.fresh)))));
  });

program
  .command("apply [ids...]")
  .description("The whole loop: fill with JEV, resolve what is left with Claude, verify, and with --submit send every form that is ready")
  .option("--count <n>", "with no ids: take this many jobs from the top of the queue", (v) => parseInt(v, 10), 1)
  .option("--submit", "submit each form that ends up ready. Without it, forms are left open in the window for review")
  .option("--dry", "a rehearsal: fill and resolve, record nothing, submit nothing, close the tabs")
  .option("--fresh", "ignore the answer memory and ask Claude again")
  .option("--json")
  .action(async (ids: string[], o: RunOptions & { submit?: boolean }) => {
    const began = new Date().toISOString();
    const { reports, sent } = await pipeline(takeJobs(ids, o), { submit: !!o.submit, dry: !!o.dry, fresh: !!o.fresh, quiet: !!o.json });
    if (o.json) console.log(JSON.stringify(reports, null, 2));
    if (o.dry) {
      if (!o.json) console.log(`\nCost of this run\n${formatCost(loadCost(began))}`);
      return endIfAbandoned();
    }
    await noteApplied(sent);
    const done = reports.map((r) => loadQueue().entries.find((e) => e.job.id === r.jobId)).filter((e): e is QueueEntry => !!e);
    console.log(`\nCost of this run\n${formatCost(loadCost(began))}`);
    console.log(`\n${done.filter((e) => e.status === "applied").length} applied, ${done.filter((e) => e.status === "needs_review").length} need review, ${done.filter((e) => e.status === "blocked" || e.status === "skipped" || e.status === "failed").length} blocked, skipped or failed, ${done.filter((e) => e.status === "in_progress").length} filled and waiting for submit`);
    const codes = done.filter((e) => e.status === "needs_review" && (e.statusReason ?? "").startsWith(CODE_PREFIX)).length;
    if (codes) console.log(`${codes} form(s) are waiting for a code that was emailed to you. Run: codes`);
    console.log(whereTheRecordIs());
    endIfAbandoned();
  });

const whereTheRecordIs = () => `Applications you sent: ${PATHS.applied}\nEvery job considered: ${PATHS.applications}`;

program
  .command("log")
  .description("Your applications: the ones you sent, newest first. The same list is in applied.csv at the top of this folder")
  .option("--all", "every job the tool considered, not only the ones you sent")
  .option("--json", "print the rows as JSON with plain field names")
  .option("--open", "open the file in your spreadsheet program")
  .action((o: { all?: boolean; json?: boolean; open?: boolean }) => {
    const rows = loadRows();
    // Writing the rows back rebuilds applied.csv, so it exists even before the first save of this version.
    if (rows.length) saveRows(rows);
    const file = o.all ? PATHS.applications : PATHS.applied;
    if (o.open) {
      if (!existsSync(file)) return console.log(`Nothing to open yet. ${file} is created by the first discover run.`);
      if (process.platform === "darwin") spawn("open", [file], { stdio: "ignore", detached: true }).unref();
      return console.log(file);
    }
    const records = o.all ? rows.map(toRecord) : appliedRecords(rows);
    if (o.json) return console.log(JSON.stringify(records, null, 2));
    for (const r of records) console.log(`${(r.applied_on || "          ").padEnd(10)}  ${r.company.slice(0, 24).padEnd(24)} ${r.role.slice(0, 46).padEnd(46)} ${r.location.slice(0, 26).padEnd(26)} ${o.all && "status" in r ? String(r.status).slice(0, 30).padEnd(30) + " " : ""}${r.job_link}`);
    console.log(`\n${records.length} ${o.all ? "jobs considered" : "applications sent"}\n${whereTheRecordIs()}`);
  });

program
  .command("doctor")
  .description("Check that everything a run needs is in place, and say what to do next")
  .option("--online", "also make one tiny JEV call and one tiny Claude Code call to prove the key and the sign-in work")
  .option("--json")
  .action(async (o: { online?: boolean; json?: boolean }) => {
    const checks = await runChecks(!!o.online);
    console.log(o.json ? JSON.stringify({ ready: isReadyToRun(checks), next: nextStep(checks), checks }, null, 2) : formatChecks(checks));
    if (!isReadyToRun(checks)) process.exitCode = 1;
  });

program
  .command("memory")
  .description("The answer memory: answers Claude gave before, reused so the same question is not paid for twice")
  .option("--forget <text>", "forget every remembered answer whose question or company contains this text")
  .option("--clear", "forget everything")
  .option("--json")
  .action((o: { forget?: string; clear?: boolean; json?: boolean }) => {
    const fingerprint = contextFingerprint(loadProfile());
    let mem = loadMemory();
    if (o.clear) {
      saveMemory({ version: 1, forms: {}, answers: [] });
      return console.log("The answer memory is empty.");
    }
    if (o.forget) {
      const t = o.forget.toLowerCase();
      const before = mem.answers.length + Object.keys(mem.forms).length;
      mem = { version: 1, answers: mem.answers.filter((a) => !a.question.toLowerCase().includes(t) && !a.company.toLowerCase().includes(t)), forms: Object.fromEntries(Object.entries(mem.forms).filter(([, f]) => !f.company.toLowerCase().includes(t))) };
      saveMemory(mem);
      return console.log(`Forgot ${before - mem.answers.length - Object.keys(mem.forms).length} entries.`);
    }
    // Entries written before the profile last changed can never match again, so they are dropped here.
    const current = prune(mem, fingerprint);
    if (existsSync(PATHS.memory)) saveMemory(current);
    if (o.json) return console.log(JSON.stringify(current, null, 2));
    for (const a of current.answers) console.log(`${a.question.slice(0, 90).padEnd(90)}  ${a.value.replace(/\s+/g, " ").slice(0, 60).padEnd(60)}  (${a.company})`);
    console.log(`\n${current.answers.length} answers that hold on any form, ${Object.keys(current.forms).length} forms remembered whole. File: ${PATHS.memory}`);
    console.log("An answer is reused only while your profile, drafts and voice guide stay as they were when it was written.");
  });

program
  .command("cost")
  .description("What the tool has spent on JEV and on Claude, by purpose, and per form")
  .option("--since <iso>", "count only calls at or after this time, for example 2026-10-02T16:00:00Z")
  .option("--json")
  .action((o: { since?: string; json?: boolean }) => {
    const c = loadCost(o.since ?? "");
    console.log(o.json ? JSON.stringify(c, null, 2) : formatCost(c));
  });

program
  .command("survey")
  .description("Totals over every fill report in data/runs: how many fields landed, and what did not")
  .action(() => {
    const reports = readdirSync(PATHS.runs).filter((f) => f.endsWith(".report.json")).map((f) => JSON.parse(readFileSync(path.join(PATHS.runs, f), "utf8")) as FillReport);
    const t = { forms: 0, blocked: 0, fields: 0, landed: 0, failed: 0, reviews: 0, drafts: 0, emptyRequired: 0 };
    for (const r of reports.sort((a, b) => a.ats.localeCompare(b.ats) || a.company.localeCompare(b.company))) {
      const wanted = r.fields.filter((f) => f.action === "fill" || f.action === "upload");
      const landed = wanted.filter((f) => f.shown).length;
      t.forms++;
      if (r.state === "blocked") t.blocked++;
      t.fields += r.fields.length;
      t.landed += landed;
      t.failed += r.failed.length;
      t.reviews += r.reviews.length;
      t.drafts += r.drafts.length;
      t.emptyRequired += r.missingRequired.length;
      console.log(`${r.ats.padEnd(12)} ${r.company.slice(0, 22).padEnd(22)} ${r.title.slice(0, 38).padEnd(38)} ${r.state === "blocked" ? `blocked: ${r.reason}` : `${String(r.fields.length).padStart(3)} fields  ${landed}/${wanted.length} landed  ${r.failed.length} failed  ${r.reviews.length} review  ${r.drafts.length} draft  ${r.missingRequired.length} empty-required  ${r.seconds.toFixed(1)}s`}`);
    }
    console.log(`\n${t.forms} forms (${t.blocked} blocked), ${t.fields} fields: ${t.landed} landed, ${t.failed} failed, ${t.reviews} for review, ${t.drafts} to draft, ${t.emptyRequired} required still empty`);
  });

program
  .command("set <id>")
  .description("Write extra values into a form that fill opened: drafts and review decisions")
  .requiredOption("--values <file>", "JSON array of { selector, kind, value }")
  .action(async (id: string, o: { values: string }) => {
    const fills = JSON.parse(readFileSync(o.values, "utf8")) as Fill[];
    console.log(JSON.stringify(await setValues(loadProfile(), id, fills), null, 2));
  });

program
  .command("inspect <id>")
  .description("Show what a filled form holds right now, and any validation errors on the page")
  .action(async (id: string) => {
    const r = await inspect(id);
    for (const f of r.fields) console.log(`${f.required ? "*" : " "} ${f.action.padEnd(6)} ${f.label.slice(0, 90).padEnd(90)} ${f.shown.slice(0, 80)}`);
    if (r.errors.length) console.log(`errors: ${r.errors.join(" | ")}`);
  });

program
  .command("submit <ids...>")
  .description("Click Submit on ready forms, classify the result with JEV, and record applied ones")
  .option("--keep-open", "leave the tab open after a confirmed submission")
  .option("--force", "submit even though the form is not marked ready")
  .action(async (ids: string[], o: { keepOpen?: boolean; force?: boolean }) => {
    const jev = new JevClient();
    const sent: string[] = [];
    for (const id of ids) if (await submitAndRecord(jev, id, !!o.force, !!o.keepOpen)) sent.push(id);
    await noteApplied(sent);
  });

program
  .command("check <ids...>")
  .description("Read what each job's tab shows now, without clicking. Records the job as applied if the page is a confirmation. Use it after you finished a form by hand")
  .action(async (ids: string[]) => {
    const jev = new JevClient();
    const sent: string[] = [];
    for (const id of ids) {
      try {
        const r = await checkJob(jev, id);
        console.log(`${id}  ${r.needsCode ? "still needs your code" : r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
        if (r.state === "submitted") {
          record(id, "applied", null);
          await closeJobTab(id);
          sent.push(id);
        } else console.log(`  page ends: ${r.excerpt}`);
      } catch (err) {
        console.log(`${id}  not checked: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await noteApplied(sent);
    console.log(`${sent.length} of ${ids.length} recorded as applied`);
  });

/** Records a site as connected, takes it off the walled list, and puts its blocked jobs back in the queue. Returns how many. */
function recordConnected(address: string): number {
  const host = siteHost(address);
  saveSites(addSite(loadSites(), address));
  forgetWalledHost(address);
  const q = loadQueue();
  let rows = loadRows();
  let back = 0;
  for (const e of q.entries) {
    if (e.status !== "blocked" || siteHost(e.job.url) !== host || !needsSignIn(e)) continue;
    rows = upsertEntry(rows, updateEntry(q, e.job.id, { status: "queued", statusReason: null }));
    back++;
  }
  saveQueue(q);
  saveRows(rows);
  return back;
}

/** Opens one site and waits for the person to sign in. `stop` lets them skip it. */
async function signInTo(address: string, stop?: () => boolean): Promise<"signed_in" | "skipped" | "not_finished" | "no_sign_in_seen"> {
  let said = "";
  const state = await waitForSignIn(address, {
    ...(stop ? { stop } : {}),
    onTick: (s, left) => {
      const line = s === "waiting" ? "  Waiting for you to finish signing in." : s === "no_sign_in_seen" ? "  Waiting for the sign-in page. Open it in that window if the site has not shown it." : "";
      if (line && line !== said) console.log(`${line} (${Math.max(1, Math.round(left / 60))} min left)`);
      said = line || said;
    },
  });
  if (stop?.()) return "skipped";
  return state === "signed_in" ? "signed_in" : state === "no_sign_in_seen" ? "no_sign_in_seen" : "not_finished";
}

program
  .command("connect [url]")
  .description("Sign in to a job site yourself, in the tool's Chrome window. The tool waits, types nothing, and remembers the site once you are in")
  .option("--already", "you are signed in there already: just record the site")
  .option("--all", "go through every site whose jobs are waiting on a sign-in, one at a time")
  .action(async (url: string | undefined, o: { already?: boolean; all?: boolean }) => {
    if (o.all || !url) {
      const todo = sitesNeedingSignIn(loadQueue().entries);
      if (!todo.length) return console.log("No job is waiting on a sign-in.");
      console.log(`${todo.length} site(s) have jobs that need a sign-in. Each opens in the tool's Chrome window. Sign in there yourself; the tool does not touch the page.`);
      let skip = false;
      if (process.stdin.isTTY) process.stdin.on("data", () => (skip = true));
      let connected = 0;
      for (const [i, site] of todo.entries()) {
        console.log(`\n${i + 1} of ${todo.length}: ${site.host} (${site.companies.join(", ")}, ${site.jobs} job${site.jobs === 1 ? "" : "s"})${process.stdin.isTTY ? ". Press Enter to skip this site." : ""}`);
        skip = false;
        const result = await signInTo(site.url, () => skip);
        if (result === "signed_in") {
          const back = recordConnected(site.url);
          connected++;
          console.log(`  Connected.${back ? ` ${back} job(s) are back in the queue.` : ""}`);
        } else console.log(result === "skipped" ? "  Skipped." : result === "no_sign_in_seen" ? `  No sign-in page was shown. If you are signed in there, run: connect ${site.host} --already` : "  Not finished in time.");
      }
      if (process.stdin.isTTY) process.stdin.pause();
      console.log(`\n${connected} of ${todo.length} connected.${connected ? " Run discover to pick up the jobs on them." : ""}`);
      return;
    }
    const host = siteHost(url);
    if (!host) throw new Error(`Not a web address: ${url}`);
    const address = url.includes("://") ? url : `https://${url}`;
    if (!o.already) {
      console.log(`Opening ${host} in the tool's Chrome window. Sign in there. Type your password yourself; the tool does not touch the page.`);
      const result = await signInTo(address);
      if (result !== "signed_in") {
        console.log(result === "no_sign_in_seen" ? `No sign-in page was shown on ${host}. If you are signed in there already, run: connect ${url} --already` : `The sign-in to ${host} was not finished in time. Run connect again when you are ready.`);
        process.exitCode = 1;
        return;
      }
    }
    const back = recordConnected(address);
    console.log(`${host} is connected.${back ? ` ${back} job(s) there are back in the queue.` : ""} The next discover will keep jobs from this site.`);
  });

program
  .command("sites")
  .description("The job sites you have signed in to")
  .action(() => {
    const sites = loadSites();
    for (const s of sites) console.log(`${s.host.padEnd(40)} connected ${s.connectedAt.slice(0, 10)}`);
    console.log(sites.length ? `\n${sites.length} site(s). To sign the tool out of one: disconnect <host>` : "No sites connected. To sign in to one: connect <url>");
  });

program
  .command("disconnect <host>")
  .description("Sign the tool's Chrome window out of a site and forget it")
  .action(async (given: string) => {
    const host = siteHost(given);
    await forgetSite(host);
    saveSites(loadSites().filter((s) => s.host !== host));
    console.log(`${host} is disconnected. Its cookies and stored data are gone from the tool's Chrome profile.`);
  });

/** The jobs mail may be about: the ones applied to, and the ones waiting for an emailed code. */
function jobsForMail(): AppliedJob[] {
  return loadQueue()
    .entries.filter((e) => e.status === "applied" || (e.status === "needs_review" && (e.statusReason ?? "").startsWith(CODE_PREFIX)))
    .map((e) => ({ id: e.job.id, company: e.job.company, title: e.job.title, appliedAt: e.appliedAt }));
}

/** Reads recent mail and records what is new. Returns null when Gmail is not set up. */
async function readMail(days: number): Promise<{ news: { job: AppliedJob; kind: string; at: string; subject: string }[] } | null> {
  const creds = mailCredentials();
  if (!creds) return null;
  const jobs = jobsForMail();
  const box = await Mailbox.open(creds);
  try {
    const headers = await box.headersSince(new Date(Date.now() - days * 86_400_000));
    const { news, inbox } = await sortMail(headers, jobs, loadInbox(), (uid) => box.text(uid), new JevClient());
    saveInbox(inbox);
    // The latest reply for each job goes in the record.
    const q = loadQueue();
    let rows = loadRows();
    for (const jobId of new Set(news.map((n) => n.job.id))) {
      const e = q.entries.find((x) => x.job.id === jobId);
      const reply = latestReply(inbox, jobId);
      if (e && reply) rows = upsertEntry(rows, e, { Response: REPLY_LABEL[reply.kind as keyof typeof REPLY_LABEL] ?? "", "Response On": reply.at.slice(0, 10) });
    }
    saveRows(rows);
    return { news: news.map((n) => ({ job: n.job, kind: n.seen.kind, at: n.seen.at, subject: n.seen.subject })) };
  } finally {
    await box.close();
  }
}

const GMAIL_HOW = "Gmail is not set up. Add GMAIL_ADDRESS and GMAIL_APP_PASSWORD to .env yourself (see docs/SETUP.md). The tool only reads mail.";

program
  .command("inbox")
  .description("Read replies from the companies you applied to and record them. Mail is only read, never changed")
  .option("--days <n>", "how far back to read", (v) => parseInt(v, 10), MAIL.lookbackDays)
  .option("--json")
  .action(async (o: { days: number; json?: boolean }) => {
    const res = await readMail(o.days);
    if (!res) {
      console.log(GMAIL_HOW);
      process.exitCode = 1;
      return;
    }
    if (o.json) return console.log(JSON.stringify(res.news, null, 2));
    const replies = res.news.filter((n) => n.kind !== "code");
    for (const n of replies.filter((x) => x.kind !== "received")) console.log(`${(REPLY_LABEL[n.kind as keyof typeof REPLY_LABEL] ?? n.kind).padEnd(20)} ${n.job.company.slice(0, 26).padEnd(26)} ${n.at.slice(0, 10)}  ${n.subject.slice(0, 70)}`);
    const received = replies.filter((x) => x.kind === "received").length;
    const codes = res.news.filter((n) => n.kind === "code");
    console.log(`\n${replies.length} new message(s) about your applications${received ? `, ${received} of them only confirming receipt` : ""}.`);
    if (codes.length) console.log(`A code was emailed for: ${[...new Set(codes.map((c) => c.job.company))].join(", ")}. Run: codes`);
    console.log(whereTheRecordIs());
  });

program
  .command("codes")
  .description("Finish the forms that are waiting for an emailed code. The tool shows each form in turn; you type the code and click Submit; it records the result")
  .action(async () => {
    const waiting = loadQueue().entries.filter((e) => e.status === "needs_review" && (e.statusReason ?? "").startsWith(CODE_PREFIX));
    if (!waiting.length) return console.log("No form is waiting for a code.");
    const jev = new JevClient();
    // With Gmail set up, the tool can say whether each code has arrived. It never opens a code message.
    let mail = false;
    try {
      mail = !!(await readMail(2));
    } catch (err) {
      console.log(`Could not read mail (${err instanceof Error ? err.message : String(err)}). Carrying on without it.`);
    }
    let skip = false;
    if (process.stdin.isTTY) process.stdin.on("data", () => (skip = true));
    const sent: string[] = [];
    for (const [i, e] of waiting.entries()) {
      console.log(`\n${i + 1} of ${waiting.length}: ${e.job.company} | ${e.job.title}`);
      if (!(await hasOpenTab(e.job.id))) {
        console.log(`  Its tab is closed. Fill it again with: apply ${e.job.id} --submit`);
        continue;
      }
      if (mail) {
        const code = codeArrived(loadInbox(), e.job.id);
        console.log(code ? `  A code was emailed at ${new Date(code.at).toLocaleTimeString()} by ${code.from}. It is in your inbox.` : "  No code email found yet. If none comes, click Submit in the tab to have it sent again.");
      }
      console.log(`  The form is in front in the tool's Chrome window. Type the code and click Submit.${process.stdin.isTTY ? " Press Enter here to skip this one." : ""}`);
      skip = false;
      const result = await watchForConfirmation(jev, e.job.id, { timeoutMs: RUN.codeWaitMs, stop: () => skip });
      if (result === "submitted") {
        record(e.job.id, "applied", null);
        await closeJobTab(e.job.id);
        sent.push(e.job.id);
        console.log("  Sent and recorded.");
      } else console.log("  Not sent yet. It stays open; run codes again when you are ready.");
    }
    if (process.stdin.isTTY) process.stdin.pause();
    await noteApplied(sent);
    console.log(`\n${sent.length} of ${waiting.length} sent.\n${whereTheRecordIs()}`);
  });

program
  .command("close <ids...>")
  .description("Close the runner tabs of these jobs")
  .action(async (ids: string[]) => {
    for (const id of ids) await closeJobTab(id);
  });

program
  .command("page-state")
  .description("Classify a page's text: form, success, login, captcha, closed, error")
  .requiredOption("--text <file>", "plain text of the page (from read_page or innerText)")
  .option("--url <url>")
  .action(async (o: { text: string; url?: string }) => {
    const jev = new JevClient();
    const res = await decidePageState(jev, readFileSync(o.text, "utf8"), o.url ?? "");
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("answer-context")
  .description("Print everything Claude needs to draft a free-text answer in the candidate's voice")
  .option("--job <id>")
  .option("--question <text>", "the question being answered, to pick the closest bank answer")
  .action((o: { job?: string; question?: string }) => {
    const profile = loadProfile();
    const q = loadQueue();
    const entry = o.job ? q.entries.find((e) => e.job.id === o.job) ?? null : null;
    console.log(JSON.stringify(answerContext(profile, entry, o.question ?? ""), null, 2));
  });

program
  .command("status")
  .description("Run summary: applied, skipped by reason, JEV spend")
  .option("--json")
  .action((o: { json?: boolean }) => {
    const q = loadQueue();
    const by = (s: QueueEntry["status"]) => q.entries.filter((e) => e.status === s);
    const reasons: Record<string, number> = {};
    for (const e of q.entries) if (e.status !== "queued" && e.status !== "applied") reasons[e.statusReason ?? e.status] = (reasons[e.statusReason ?? e.status] ?? 0) + 1;
    const summary = {
      generatedAt: q.generatedAt,
      total: q.entries.length,
      applied: by("applied").length,
      queued: by("queued").length,
      inProgress: by("in_progress").length,
      needsReview: by("needs_review").length,
      blocked: by("blocked").length,
      failed: by("failed").length,
      skipped: by("skipped").length,
      appliedToday: by("applied").filter((e) => (e.appliedAt ?? "").slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
      topSkipReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
    out(summary, !!o.json, () => {
      console.log(`Queue from ${summary.generatedAt}`);
      console.log(`applied ${summary.applied} (today ${summary.appliedToday}) | queued ${summary.queued} | in progress ${summary.inProgress} | needs review ${summary.needsReview} | blocked ${summary.blocked} | failed ${summary.failed} | skipped ${summary.skipped}`);
      for (const [r, n] of summary.topSkipReasons) console.log(`  ${String(n).padStart(4)}  ${r}`);
      console.log(whereTheRecordIs());
    });
  });

const notReady = (r: FillReport) =>
  r.resolution && r.resolution.verdict !== "ready" && r.resolution.reason
    ? r.resolution.reason
    : [...r.missingRequired.map((l) => `empty: ${l.slice(0, 60)}`), ...r.failed.map((f) => `did not land: ${f.label.slice(0, 60)}`), ...r.reviews.map((x) => `unsure: ${x.label.slice(0, 60)}`), ...r.drafts.map((x) => `unwritten: ${x.label.slice(0, 60)}`)].join("; ") || (r.reason ?? "not verified");

const CODE_PREFIX = "the board emailed you a code";
const CODE_REASON = (id: string) => `${CODE_PREFIX} to confirm a person is applying. Type it into the open tab, click Submit, then run: check ${id}`;
/** Submissions to one site are spaced out, and only one form is being sent at any moment. A burst from one person reads as a robot. */
const perSite = spacer(RUN.submitGapMs);
const oneAtATime = limiter(1);
const siteOf = (id: string) => {
  try {
    return hostOf(loadReport(id).url).split(".").slice(-2).join(".");
  } catch {
    return id;
  }
};
const submitAndRecord = (jev: JevClient, id: string, force: boolean, keepOpen = false): Promise<boolean> => perSite(siteOf(id), () => oneAtATime(() => sendAndRecord(jev, id, force, keepOpen)));

/** Submits one ready form and records what the page became: applied, or failed with what the page said. */
async function sendAndRecord(jev: JevClient, id: string, force: boolean, keepOpen = false): Promise<boolean> {
  try {
    const r = await submitJob(jev, id, force);
    console.log(`${id}  ${r.needsCode ? "needs your code" : r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
    if (r.state === "submitted") {
      record(id, "applied", null);
      if (!keepOpen) await closeJobTab(id);
      return true;
    } else if (r.needsCode) {
      // Only the person can pass a human check. The tab stays open, filled, for them.
      record(id, "needs_review", CODE_REASON(id));
    } else {
      if (r.errors.length) console.log(`  errors: ${r.errors.join(" | ")}`);
      console.log(`  page: ${r.excerpt}`);
      record(id, r.state === "captcha" || r.state === "login_required" ? "blocked" : "needs_review", `after submit the page was: ${r.state}${r.errors.length ? ` (${r.errors.slice(0, 3).join("; ").slice(0, 160)})` : ""}`);
    }
  } catch (err) {
    console.log(`${id}  not submitted: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

/**
 * Fills the two sheet cells a person would otherwise write by hand, for every job just applied to.
 * A form Claude resolved already carries its note. The rest are written in one writer call.
 */
async function noteApplied(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const entries = loadQueue().entries.filter((e) => ids.includes(e.job.id));
  const notes = new Map<string, { whatTheyDo: string; whyFit: string }>();
  for (const e of entries) {
    try {
      const n = loadReport(e.job.id).resolution?.note;
      if (n && (n.what_they_do || n.why_fit)) notes.set(e.job.id, { whatTheyDo: n.what_they_do, whyFit: n.why_fit });
    } catch {
      /* no report: the batch call below covers it */
    }
  }
  for (const [id, n] of await logNotes(loadProfile(), entries.filter((e) => !notes.has(e.job.id)))) notes.set(id, n);
  let rows = loadRows();
  for (const e of entries) {
    const n = notes.get(e.job.id);
    if (n && (n.whatTheyDo || n.whyFit)) rows = upsertEntry(rows, e, { "What They Do": n.whatTheyDo, "Why You're a Fit": n.whyFit });
  }
  saveRows(rows);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function printFill(r: FillReport) {
  console.log(`\n== ${r.company} | ${r.title} [${r.jobId}] ${r.state === "filled" ? (r.ready ? "READY" : r.multiPage ? "first page filled, not ready" : "filled, not ready") : "blocked"} in ${r.seconds.toFixed(1)}s, JEV $${r.jevCostUsd.toFixed(4)}`);
  if (r.resolution) console.log(`   ${r.writerCalled === false ? "Memory" : "Claude"}: ${r.resolution.verdict}${r.resolution.reason ? `, ${r.resolution.reason}` : ""} (${r.resolution.answers.length} answers${r.recalled ? `, ${r.recalled} from memory` : ""}${r.writerCalled === false ? ", Claude was not asked" : ""})`);
  console.log(`   ${r.url}`);
  if (r.reason) console.log(`   ${r.reason}`);
  for (const f of r.fields) console.log(`   ${f.required ? "*" : " "} ${f.action.padEnd(6)} ${f.label.slice(0, 80).padEnd(80)} ${f.shown.slice(0, 70)}${f.note ? `  (${f.note})` : ""}`);
  for (const d of r.drafts) console.log(`   DRAFT  ${d.selector}  intent=${d.intent} max=${d.maxLength ?? "-"}  ${d.label.slice(0, 200)}`);
  for (const v of r.reviews) console.log(`   REVIEW ${v.selector}  [${v.kind}] ${v.label.slice(0, 160)}  why=${v.why}  options=${v.options.slice(0, 15).join(" | ")}`);
  for (const f of r.failed) console.log(`   FAILED ${f.selector}  ${f.label.slice(0, 60)}: ${f.why}`);
  for (const f of r.leftBlank ?? []) console.log(`   LEFT BLANK (optional) ${f.label.slice(0, 60)}: ${f.why}`);
  if (r.missingRequired.length) console.log(`   EMPTY REQUIRED: ${r.missingRequired.map((l) => l.slice(0, 60)).join(" | ")}`);
}

function brief(e: QueueEntry) {
  return {
    id: e.job.id,
    company: e.job.company,
    title: e.job.title,
    url: e.job.url,
    ats: e.job.ats,
    locations: e.job.locations,
    postedAt: e.job.postedAt,
    score: e.fit?.score ?? null,
    status: e.status,
    reason: e.statusReason,
    notes: e.fit?.reasons ?? [],
  };
}

function printTable(entries: QueueEntry[]) {
  for (const e of entries) {
    const score = e.fit ? e.fit.score.toFixed(2) : "  -  ";
    console.log(`${score}  ${e.job.postedAt ?? "          "}  ${e.job.ats.padEnd(13)} ${e.job.company.slice(0, 28).padEnd(28)} ${e.job.title.slice(0, 60).padEnd(60)} ${e.job.locations.join(" / ").slice(0, 40)}  [${e.job.id}]`);
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
