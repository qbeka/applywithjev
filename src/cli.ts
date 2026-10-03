#!/usr/bin/env -S npx tsx
/**
 * applywithjev command line. Each command is a thin wrapper: the work is in
 * discover.ts, run/pipeline.ts and browser/. Commands that list things take
 * --json so their output can be read by a program.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { contextFingerprint } from "./answers/resolve.js";
import { loadMemory, prune, saveMemory } from "./answers/memory.js";
import { inspect, setValues } from "./browser/formRunner.js";
import { loadReport, type Fill, type FillReport } from "./browser/report.js";
import { closeJobTab, hasOpenTab } from "./browser/session.js";
import { checkJob, watchForConfirmation } from "./browser/submit.js";
import { loadEnv, DISCOVER, PATHS, RUN } from "./config.js";
import { discover } from "./discover.js";
import { formatChecks, isReadyToRun, nextStep, runChecks } from "./doctor.js";
import { JevClient } from "./jev/client.js";
import { loadKnowledge, shareKnowledge } from "./knowledge/sites.js";
import { loadQueue, saveQueue, sortEntries, updateEntry, QueueStatus } from "./jobs/queue.js";
import { formatCost, loadCost } from "./log/cost.js";
import { appliedRecords, loadRows, manualRecords, saveRows, toRecord, upsertEntry } from "./log/csv.js";
import { loadProfile } from "./profile/schema.js";
import { endIfAbandoned, HUMAN_PREFIX, noteApplied, pipeline, recordApplied, resolvePage, submitAndRecord, takeJobs, waitsForYou } from "./run/pipeline.js";
import { brief, printFill, printTable } from "./run/print.js";
import { limiter } from "./util/pace.js";

loadEnv();
// Output piped into a command that stops reading early (head, a pager) is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
const program = new Command();
program.name("applywithjev").description("Find and rate software jobs with JEV, fill and check each application form in Chrome, and let Claude Code write what needs writing.").version("0.1.0");

const int = (v: string) => parseInt(v, 10);
const whereTheRecordIs = () => `Applications you sent: ${PATHS.applied}\nJobs left for you to do by hand: ${PATHS.manual}\nTake-home assignments to do: ${PATHS.takehome}\nEvery job considered: ${PATHS.applications}`;

// ---------------------------------------------------------------- find jobs

program
  .command("discover")
  .description("Find jobs: read every source, filter, rate with JEV, and write the queue and the record")
  .option("--no-boards", "skip polling company boards directly")
  .option("--limit <n>", "rate at most n new jobs (for a quick test)", int)
  .option("--max-age <days>", `consider postings up to this many days old (default ${DISCOVER.maxAgeDays})`, int)
  .option("--json", "print the summary as JSON")
  .action(async (o: { boards: boolean; limit?: number; maxAge?: number; json?: boolean }) => {
    const { queue, summary } = await discover(loadProfile(), new JevClient(), { boards: o.boards, ...(o.limit !== undefined ? { limit: o.limit } : {}), ...(o.maxAge !== undefined ? { maxAgeDays: o.maxAge } : {}), log: (l) => console.error(l) });
    const top = sortEntries(queue.entries.filter((e) => e.status === "queued")).slice(0, RUN.listed);
    if (o.json) return console.log(JSON.stringify({ summary, top: top.map(brief) }, null, 2));
    console.log(`\n${summary.unique} unique postings, ${summary.preFiltered} removed by code filters, ${summary.rated} rated by JEV (${summary.reused} of them from earlier ratings).`);
    console.log(`${summary.queued} queued (score ≥ ${DISCOVER.applyThreshold}), ${summary.belowThreshold} below threshold, ${summary.skippedByJev} skipped by JEV.`);
    console.log(`JEV: ${summary.jevCalls} calls, $${summary.jevCostUsd.toFixed(4)}.\n`);
    printTable(top);
  });

program
  .command("queue")
  .description("List the ranked jobs")
  .option("--all", "include skipped and applied entries")
  .option("--limit <n>", "rows to show", int, 50)
  .option("--json")
  .action((o: { all?: boolean; limit: number; json?: boolean }) => {
    const q = loadQueue();
    const entries = sortEntries(o.all ? q.entries : q.entries.filter((e) => e.status === "queued")).slice(0, o.limit);
    if (o.json) console.log(JSON.stringify(entries.map(brief), null, 2));
    else printTable(entries);
  });

// ------------------------------------------------------------------- apply

type ApplyOptions = { count: number; dry?: boolean; submit?: boolean; fresh?: boolean; json?: boolean };

program
  .command("apply [ids...]")
  .description("Fill each form, answer what is open, walk its pages, check every answer, and with --submit send every form that is ready")
  .option("--count <n>", "with no ids: take this many jobs from the top of the queue", int, 1)
  .option("--submit", "send each form the moment it is ready. Without it, ready forms are left open in the window")
  .option("--dry", "a rehearsal: record nothing, send nothing, close the tabs")
  .option("--fresh", "ignore the answer memory and ask Claude again")
  .option("--json")
  .action(async (ids: string[], o: ApplyOptions) => {
    const began = new Date().toISOString();
    const { reports, sent } = await pipeline(takeJobs(ids, { count: o.count, dry: !!o.dry }), { submit: !!o.submit, dry: !!o.dry, fresh: !!o.fresh, quiet: !!o.json });
    if (o.json) console.log(JSON.stringify(reports, null, 2));
    if (!o.dry) {
      await noteApplied(sent);
      const done = new Map(loadQueue().entries.map((e) => [e.job.id, e]));
      const count = (...statuses: string[]) => reports.filter((r) => statuses.includes(done.get(r.jobId)?.status ?? "")).length;
      const codes = reports.filter((r) => waitsForYou(done.get(r.jobId)?.statusReason)).length;
      console.log(`\n${count("applied")} applied, ${count("needs_review", "blocked")} left for you, ${count("skipped", "failed")} skipped, ${count("in_progress")} filled and waiting for submit`);
      if (codes) console.log(`${codes} filled form(s) are waiting for you: a code that was emailed to you, or a robot check. Run: codes`);
      console.log(whereTheRecordIs());
    }
    if (!o.json) console.log(`\nCost of this run\n${formatCost(loadCost(began))}`);
    endIfAbandoned();
  });

program
  .command("fill [ids...]")
  .description("Fill the first page of each form with JEV and stop. Nothing is answered by Claude and nothing is sent")
  .option("--count <n>", "with no ids: take this many jobs from the top of the queue", int, 1)
  .option("--dry", "a rehearsal: leave the queue untouched and close each tab once it is filled")
  .option("--json")
  .action(async (ids: string[], o: ApplyOptions) => {
    const { reports } = await pipeline(takeJobs(ids, { count: o.count, dry: !!o.dry }), { submit: false, dry: !!o.dry, fresh: false, quiet: !!o.json, fillOnly: true });
    if (o.json) console.log(JSON.stringify(reports, null, 2));
    endIfAbandoned();
  });

program
  .command("resolve <ids...>")
  .description("Answer what is still open on filled forms: from the answer memory, or by Claude. The answers are written in and read back")
  .option("--fresh", "ignore the answer memory and ask Claude again")
  .action(async (ids: string[], o: { fresh?: boolean }) => {
    const profile = loadProfile();
    const jev = new JevClient();
    const q = loadQueue();
    const writer = limiter(RUN.writerConcurrency);
    await Promise.all(ids.map((id) => writer(async () => printFill(await resolvePage(jev, profile, q.entries.find((e) => e.job.id === id) ?? null, loadReport(id), !!o.fresh)))));
  });

program
  .command("submit <ids...>")
  .description("Send forms that are ready, read the page that comes back, and record the ones that went through")
  .option("--keep-open", "leave the tab open after a confirmed submission")
  .option("--force", "send even though the form is not marked ready")
  .action(async (ids: string[], o: { keepOpen?: boolean; force?: boolean }) => {
    const jev = new JevClient();
    const sent: string[] = [];
    for (const id of ids) if (await submitAndRecord(jev, id, !!o.force, !!o.keepOpen)) sent.push(id);
    await noteApplied(sent);
  });

// ------------------------------------------------------ forms left for you

program
  .command("codes")
  .description("Finish the forms that are waiting for you: an emailed code to type, or a robot check to pass. The tool shows each form in turn; you finish it and click Submit; it records the result")
  .action(async () => {
    const waiting = loadQueue().entries.filter((e) => e.status === "needs_review" && waitsForYou(e.statusReason));
    if (!waiting.length) return console.log("No form is waiting for a code or a robot check.");
    const jev = new JevClient();
    let skip = false;
    if (process.stdin.isTTY) process.stdin.on("data", () => (skip = true));
    const sent: string[] = [];
    for (const [i, e] of waiting.entries()) {
      console.log(`\n${i + 1} of ${waiting.length}: ${e.job.company} | ${e.job.title}`);
      if (!(await hasOpenTab(e.job.id))) {
        console.log(`  Its tab is closed. Fill it again with: apply ${e.job.id} --submit`);
        continue;
      }
      console.log(`  The form is in front in the tool's Chrome window. ${(e.statusReason ?? "").startsWith(HUMAN_PREFIX) ? "Pass the robot check" : "Type the code from your email"} and click Submit.${process.stdin.isTTY ? " Press Enter here to skip this one." : ""}`);
      skip = false;
      if ((await watchForConfirmation(jev, e.job.id, { timeoutMs: RUN.codeWaitMs, stop: () => skip })) === "submitted") {
        recordApplied(e.job.id);
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
  .command("check <ids...>")
  .description("Read what each job's tab shows now, without clicking, and record the job as applied if it is a confirmation. Use it after you finished a form by hand")
  .action(async (ids: string[]) => {
    const jev = new JevClient();
    const sent: string[] = [];
    for (const id of ids) {
      try {
        const r = await checkJob(jev, id);
        console.log(`${id}  ${r.needsCode ? "still needs your code" : r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
        if (r.state === "submitted") {
          recordApplied(id);
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

program
  .command("inspect <id>")
  .description("Show what a filled form holds right now, and any errors on the page")
  .action(async (id: string) => {
    const r = await inspect(id);
    for (const f of r.fields) console.log(`${f.required ? "*" : " "} ${f.action.padEnd(6)} ${f.label.slice(0, 90).padEnd(90)} ${f.shown.slice(0, 80)}`);
    if (r.errors.length) console.log(`errors: ${r.errors.join(" | ")}`);
  });

program
  .command("set <id>")
  .description("Write answers you chose into a filled form")
  .requiredOption("--values <file>", "JSON array of { selector, kind, value }")
  .action(async (id: string, o: { values: string }) => {
    const fills = JSON.parse(readFileSync(o.values, "utf8")) as Fill[];
    console.log(JSON.stringify(await setValues(loadProfile(), id, fills), null, 2));
  });

program
  .command("close <ids...>")
  .description("Close the tabs of these jobs")
  .action(async (ids: string[]) => {
    for (const id of ids) await closeJobTab(id);
  });

program
  .command("mark <id>")
  .description("Record an outcome by hand: applied | skipped | failed | blocked | needs_review | queued")
  .requiredOption("--status <status>")
  .option("--reason <text>")
  .option("--notes <text>")
  .action((id: string, o: { status: string; reason?: string; notes?: string }) => {
    const status = QueueStatus.parse(o.status);
    const q = loadQueue();
    const e = updateEntry(q, id, { status, statusReason: o.reason ?? null, ...(o.notes ? { notes: o.notes } : {}), ...(status === "applied" ? { appliedAt: new Date().toISOString() } : {}) });
    saveQueue(q);
    saveRows(upsertEntry(loadRows(), e, o.notes ? { Notes: o.notes } : {}));
    console.log(`${e.job.company} | ${e.job.title} → ${status}${o.reason ? ` (${o.reason})` : ""}`);
  });

// ------------------------------------------------------------- the records

program
  .command("log")
  .description("Your applications: the ones you sent, newest first. The same list is in applied.csv at the top of this folder")
  .option("--manual", "the jobs left for you to do by hand, with the reason and the link (manual.csv)")
  .option("--all", "every job the tool considered")
  .option("--json", "print the rows as JSON with plain field names")
  .option("--open", "open the file in your spreadsheet program")
  .action((o: { manual?: boolean; all?: boolean; json?: boolean; open?: boolean }) => {
    const rows = loadRows();
    // Writing the rows back rebuilds applied.csv and manual.csv from the full record.
    if (rows.length) saveRows(rows);
    const file = o.all ? PATHS.applications : o.manual ? PATHS.manual : PATHS.applied;
    if (o.open) {
      if (!existsSync(file)) return console.log(`Nothing to open yet. ${file} is created by the first discover run.`);
      if (process.platform === "darwin") spawn("open", [file], { stdio: "ignore", detached: true }).unref();
      return console.log(file);
    }
    if (o.manual) {
      const todo = manualRecords(rows);
      if (o.json) return console.log(JSON.stringify(todo, null, 2));
      for (const r of todo) console.log(`${r.company.slice(0, 22).padEnd(22)} ${r.role.slice(0, 40).padEnd(40)} ${r.reason.slice(0, 70).padEnd(70)} ${r.job_link}`);
      return console.log(`\n${todo.length} job(s) left for you\n${whereTheRecordIs()}`);
    }
    const records = o.all ? rows.map(toRecord) : appliedRecords(rows);
    if (o.json) return console.log(JSON.stringify(records, null, 2));
    for (const r of records) console.log(`${(r.applied_on || "          ").padEnd(10)}  ${r.company.slice(0, 24).padEnd(24)} ${r.role.slice(0, 46).padEnd(46)} ${r.location.slice(0, 26).padEnd(26)} ${o.all && "status" in r ? String(r.status).slice(0, 30).padEnd(30) + " " : ""}${r.job_link}`);
    console.log(`\n${records.length} ${o.all ? "jobs considered" : "applications sent"}\n${whereTheRecordIs()}`);
  });

program
  .command("status")
  .description("Totals, and the reasons jobs were skipped")
  .option("--json")
  .action((o: { json?: boolean }) => {
    const q = loadQueue();
    const by = (s: string) => q.entries.filter((e) => e.status === s);
    const reasons: Record<string, number> = {};
    for (const e of q.entries) if (e.status !== "queued" && e.status !== "applied") reasons[e.statusReason ?? e.status] = (reasons[e.statusReason ?? e.status] ?? 0) + 1;
    const today = new Date().toDateString();
    const summary = {
      generatedAt: q.generatedAt,
      total: q.entries.length,
      applied: by("applied").length,
      appliedToday: by("applied").filter((e) => e.appliedAt && new Date(e.appliedAt).toDateString() === today).length,
      queued: by("queued").length,
      inProgress: by("in_progress").length,
      leftForYou: by("needs_review").length + by("blocked").length,
      failed: by("failed").length,
      skipped: by("skipped").length,
      topSkipReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
    if (o.json) return console.log(JSON.stringify(summary, null, 2));
    console.log(`Queue from ${summary.generatedAt}`);
    console.log(`applied ${summary.applied} (today ${summary.appliedToday}) | queued ${summary.queued} | in progress ${summary.inProgress} | left for you ${summary.leftForYou} | failed ${summary.failed} | skipped ${summary.skipped}`);
    for (const [r, n] of summary.topSkipReasons) console.log(`  ${String(n).padStart(4)}  ${r}`);
    console.log(whereTheRecordIs());
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
  .description("Totals over every fill report: how many answers landed, and what did not")
  .action(() => {
    const reports = readdirSync(PATHS.runs).filter((f) => f.endsWith(".report.json")).map((f) => loadReport(path.basename(f, ".report.json")));
    const t = { forms: 0, blocked: 0, fields: 0, landed: 0, failed: 0, reviews: 0, drafts: 0, emptyRequired: 0 };
    for (const r of reports.sort((a: FillReport, b: FillReport) => a.ats.localeCompare(b.ats) || a.company.localeCompare(b.company))) {
      const all = [...r.earlier, ...r.fields];
      const wanted = all.filter((f) => f.action === "fill" || f.action === "upload");
      const landed = wanted.filter((f) => f.shown).length;
      t.forms++;
      if (r.state === "blocked") t.blocked++;
      t.fields += all.length;
      t.landed += landed;
      t.failed += r.failed.length;
      t.reviews += r.reviews.length;
      t.drafts += r.drafts.length;
      t.emptyRequired += r.missingRequired.length;
      console.log(`${r.ats.padEnd(12)} ${r.company.slice(0, 22).padEnd(22)} ${r.title.slice(0, 38).padEnd(38)} ${r.state === "blocked" ? `blocked: ${r.reason}` : `${String(all.length).padStart(3)} fields  ${landed}/${wanted.length} landed  ${r.failed.length} failed  ${r.reviews.length} review  ${r.drafts.length} draft  ${r.missingRequired.length} empty-required  ${r.seconds.toFixed(1)}s`}`);
    }
    console.log(`\n${t.forms} forms (${t.blocked} blocked), ${t.fields} fields: ${t.landed} landed, ${t.failed} failed, ${t.reviews} for review, ${t.drafts} to draft, ${t.emptyRequired} required still empty`);
  });

// ------------------------------------------------------------ housekeeping

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
  .command("knowledge")
  .description("What the tool has learned about each site: how its controls take values, whether it wants a sign-in, how many pages its form has, and what it could not set")
  .option("--share", "write this machine's notes into knowledge/sites.json, ready to commit and send as a pull request")
  .option("--trouble", "only the controls the tool could not set: what to teach it next")
  .option("--json")
  .action((o: { share?: boolean; trouble?: boolean; json?: boolean }) => {
    if (o.share) {
      const n = shareKnowledge();
      return console.log(`${PATHS.knowledgeShipped} now holds notes on ${n} site(s). It has site names and kinds of controls in it, and nothing about you. Commit it and open a pull request to share what your runs learned.`);
    }
    const k = loadKnowledge();
    if (o.json) return console.log(JSON.stringify(k, null, 2));
    const sites = Object.entries(k.sites).sort(([, a], [, b]) => b.forms - a.forms);
    for (const [host, s] of sites) {
      const trouble = Object.entries(s.trouble);
      if (o.trouble && !trouble.length) continue;
      if (!o.trouble) {
        const ways = Object.entries(s.controls).map(([sig, c]) => `${sig} ${c.method}`).join(", ");
        console.log(`${host.padEnd(38)} ${String(s.forms).padStart(3)} forms, ${s.ready} ready${s.pages > 1 ? `, ${s.pages} pages` : ""}${s.signIn ? ", wants a sign-in" : ""}${s.emailsCode ? ", emails a code" : ""}${ways ? `\n    ${ways}` : ""}`);
      } else console.log(host);
      for (const [sig, t] of trouble) console.log(`    could not set ${sig} (${t.count}x): ${t.why}`);
    }
    console.log(`\n${sites.length} site(s) known. Shipped notes: ${PATHS.knowledgeShipped}. This machine's: ${PATHS.knowledgeLocal}.`);
  });

program
  .command("memory")
  .description("The answer memory: answers Claude gave before, reused so the same question is not paid for twice")
  .option("--forget <text>", "forget every remembered answer whose question or company contains this text")
  .option("--clear", "forget everything")
  .option("--json")
  .action((o: { forget?: string; clear?: boolean; json?: boolean }) => {
    if (o.clear) {
      saveMemory({ version: 1, forms: {}, answers: [] });
      return console.log("The answer memory is empty.");
    }
    const mem = loadMemory();
    if (o.forget) {
      const t = o.forget.toLowerCase();
      const kept = { version: 1 as const, answers: mem.answers.filter((a) => !a.question.toLowerCase().includes(t) && !a.company.toLowerCase().includes(t)), forms: Object.fromEntries(Object.entries(mem.forms).filter(([, f]) => !f.company.toLowerCase().includes(t))) };
      saveMemory(kept);
      return console.log(`Forgot ${mem.answers.length + Object.keys(mem.forms).length - kept.answers.length - Object.keys(kept.forms).length} entries.`);
    }
    // Entries written before the profile last changed can never match again, so they are dropped here.
    const current = prune(mem, contextFingerprint(loadProfile()));
    if (existsSync(PATHS.memory)) saveMemory(current);
    if (o.json) return console.log(JSON.stringify(current, null, 2));
    for (const a of current.answers) console.log(`${a.question.slice(0, 90).padEnd(90)}  ${a.value.replace(/\s+/g, " ").slice(0, 60).padEnd(60)}  (${a.company})`);
    console.log(`\n${current.answers.length} answers that hold on any form, ${Object.keys(current.forms).length} form pages remembered whole. File: ${PATHS.memory}`);
    console.log("An answer is reused only while your profile, drafts and voice guide stay as they were when it was written.");
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
