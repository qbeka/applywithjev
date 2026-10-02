#!/usr/bin/env -S npx tsx
/**
 * applywithjev command line. Claude Code calls these from the apply skill;
 * you can run them by hand too. Every command prints JSON with --json so
 * the output is machine-readable.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadEnv, DISCOVER, PATHS, RUN } from "./config.js";
import { discover } from "./discover.js";
import { JevClient } from "./jev/client.js";
import { applyUrlFor } from "./jobs/normalize.js";
import { loadQueue, nextQueued, saveQueue, sortEntries, updateEntry, QueueStatus, type QueueEntry } from "./jobs/queue.js";
import { loadRows, saveRows, upsertEntry } from "./log/csv.js";
import { loadProfile } from "./profile/schema.js";
import { answerContext } from "./answers/context.js";
import { mapForm } from "./forms/mapForm.js";
import { decidePageState } from "./forms/pageState.js";
import { FieldsDump } from "./forms/fields.js";
import { ensureBrowser } from "./browser/cdp.js";
import { closeJobTab, fillJob, inspect, loadReport, resolveJob, setValues, submitJob, type Fill, type FillReport } from "./browser/formRunner.js";
import { hostIs, type Job } from "./jobs/normalize.js";
import { rememberWalledHost } from "./jobs/walled.js";
import { logNotes } from "./answers/resolve.js";
import { formatCost, loadCost } from "./log/cost.js";

loadEnv();
const program = new Command();
program.name("applywithjev").description("Find, rate and apply to software jobs with JEV, Claude Code and Claude in Chrome.").version("0.1.0");

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

type RunOptions = { count: number; dry?: boolean; json?: boolean };

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

/** Fills every entry's form, side by side but never in a burst at one site. A form that cannot be opened comes back as blocked. */
async function fillAll(entries: QueueEntry[]): Promise<FillReport[]> {
  const profile = loadProfile();
  const jev = new JevClient();
  await ensureBrowser();
  return paced(entries, (e) => hostOf(applyUrlFor(e.job as unknown as Job)), async (e) => {
    try {
      return await fillJob(jev, profile, e.job as unknown as Job);
    } catch (err) {
      return { jobId: e.job.id, company: e.job.company, title: e.job.title, ats: e.job.ats, url: e.job.url, state: "blocked", reason: err instanceof Error ? err.message : String(err), fields: [], drafts: [], reviews: [], failed: [], missingRequired: [], ready: false, seconds: 0, jevCostUsd: 0 };
    }
  });
}

/** Hands what JEV left open to Claude, a few forms at a time. A writer error leaves the form as it was, not ready. */
async function resolveAll(reports: FillReport[]): Promise<FillReport[]> {
  const profile = loadProfile();
  const q = loadQueue();
  const out = [...reports];
  const todo = reports.map((r, i) => ({ r, i })).filter(({ r }) => r.state === "filled" && !r.ready);
  // The first form goes alone. Its call stores the candidate's context in the provider's cache,
  // and every later call reads it from there at a tenth of the price.
  const batches = [todo.slice(0, 1)];
  for (let at = 1; at < todo.length; at += RUN.writerConcurrency) batches.push(todo.slice(at, at + RUN.writerConcurrency));
  for (const batch of batches) {
    await Promise.all(
      batch.map(async ({ r, i }) => {
        try {
          out[i] = await resolveJob(profile, q.entries.find((e) => e.job.id === r.jobId) ?? null, r.jobId);
        } catch (err) {
          out[i] = { ...r, reason: `writer: ${err instanceof Error ? err.message : String(err)}` };
        }
      }),
    );
  }
  return out;
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
    const reports = await fillAll(takeJobs(ids, o));
    if (o.dry) for (const r of reports) await closeJobTab(r.jobId);
    if (o.json) console.log(JSON.stringify(reports, null, 2));
    else reports.forEach(printFill);
  });

program
  .command("resolve <ids...>")
  .description("Hand the fields JEV left open on filled forms to Claude (Sonnet 5.5, high effort), write its answers in and verify them")
  .action(async (ids: string[]) => {
    (await resolveAll(ids.map(loadReport))).forEach(printFill);
  });

program
  .command("apply [ids...]")
  .description("The whole loop: fill with JEV, resolve what is left with Claude, verify, and with --submit send every form that is ready")
  .option("--count <n>", "with no ids: take this many jobs from the top of the queue", (v) => parseInt(v, 10), 1)
  .option("--submit", "submit each form that ends up ready. Without it, forms are left open in the window for review")
  .option("--dry", "a rehearsal: fill and resolve, record nothing, submit nothing, close the tabs")
  .option("--json")
  .action(async (ids: string[], o: RunOptions & { submit?: boolean }) => {
    const began = new Date().toISOString();
    const reports = await resolveAll(await fillAll(takeJobs(ids, o)));
    if (o.json) console.log(JSON.stringify(reports, null, 2));
    else reports.forEach(printFill);
    if (o.dry) {
      for (const r of reports) await closeJobTab(r.jobId);
      if (!o.json) console.log(`\nCost of this run\n${formatCost(loadCost(began))}`);
      return;
    }
    const jev = new JevClient();
    const sent: string[] = [];
    for (const r of reports) {
      if (r.state === "blocked") {
        const e = record(r.jobId, "blocked", r.reason);
        // A login page teaches the next discover to skip that careers site.
        if (/login or account|no form found, page looks like: (login_required|job_description)/.test(r.reason ?? "")) rememberWalledHost(e.job.url);
        await closeJobTab(r.jobId);
      } else if (r.resolution?.verdict === "skip") {
        record(r.jobId, "skipped", r.resolution.reason);
        await closeJobTab(r.jobId);
      } else if (!r.ready) {
        record(r.jobId, "needs_review", notReady(r));
      } else if (o.submit) {
        if (await submitAndRecord(jev, r.jobId, false)) sent.push(r.jobId);
      }
    }
    await noteApplied(sent);
    const done = reports.map((r) => loadQueue().entries.find((e) => e.job.id === r.jobId)).filter((e): e is QueueEntry => !!e);
    console.log(`\nCost of this run\n${formatCost(loadCost(began))}`);
    console.log(`\n${done.filter((e) => e.status === "applied").length} applied, ${done.filter((e) => e.status === "needs_review").length} need review, ${done.filter((e) => e.status === "blocked" || e.status === "skipped" || e.status === "failed").length} blocked, skipped or failed, ${done.filter((e) => e.status === "in_progress").length} filled and waiting for submit`);
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
    });
  });

const notReady = (r: FillReport) =>
  r.resolution && r.resolution.verdict !== "ready" && r.resolution.reason
    ? r.resolution.reason
    : [...r.missingRequired.map((l) => `empty: ${l.slice(0, 60)}`), ...r.failed.map((f) => `did not land: ${f.label.slice(0, 60)}`), ...r.reviews.map((x) => `unsure: ${x.label.slice(0, 60)}`), ...r.drafts.map((x) => `unwritten: ${x.label.slice(0, 60)}`)].join("; ") || (r.reason ?? "not verified");

/** Submits one ready form and records what the page became: applied, or failed with what the page said. */
async function submitAndRecord(jev: JevClient, id: string, force: boolean, keepOpen = false): Promise<boolean> {
  try {
    const r = await submitJob(jev, id, force);
    console.log(`${id}  ${r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
    if (r.state === "submitted") {
      record(id, "applied", null);
      if (!keepOpen) await closeJobTab(id);
      return true;
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

/** Writes the two sheet cells a person would otherwise fill in by hand, for every job just applied to, in one writer call. */
async function noteApplied(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const entries = loadQueue().entries.filter((e) => ids.includes(e.job.id));
  const notes = await logNotes(loadProfile(), entries);
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

/** Runs work over items side by side, holding each site to RUN.perHostConcurrency at once and RUN.hostGapMs between starts. */
async function paced<T, R>(items: T[], host: (item: T) => string, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const todo = items.map((item, index) => ({ item, index }));
  const sites = new Map<string, { active: number; last: number }>();
  const worker = async () => {
    while (todo.length) {
      const now = Date.now();
      const at = todo.findIndex(({ item }) => {
        const s = sites.get(host(item));
        const gentle = RUN.gentleHosts.some((h) => hostIs(host(item), h));
        return !s || (s.active < (gentle ? 1 : RUN.perHostConcurrency) && now - s.last >= (gentle ? RUN.gentleGapMs : RUN.hostGapMs));
      });
      if (at < 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const [{ item, index }] = todo.splice(at, 1) as [{ item: T; index: number }];
      const site = sites.get(host(item)) ?? { active: 0, last: 0 };
      sites.set(host(item), { active: site.active + 1, last: Date.now() });
      try {
        results[index] = await work(item);
      } finally {
        const s = sites.get(host(item)) as { active: number; last: number };
        s.active--;
        // The pause counts from when a form finishes, not from when it started.
        s.last = Date.now();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RUN.fillConcurrency, items.length) }, worker));
  return results;
}

function printFill(r: FillReport) {
  console.log(`\n== ${r.company} | ${r.title} [${r.jobId}] ${r.state === "filled" ? (r.ready ? "READY" : "filled, not ready") : "blocked"} in ${r.seconds.toFixed(1)}s, JEV $${r.jevCostUsd.toFixed(4)}`);
  if (r.resolution) console.log(`   Claude: ${r.resolution.verdict}${r.resolution.reason ? `, ${r.resolution.reason}` : ""} (${r.resolution.answers.length} answers)`);
  console.log(`   ${r.url}`);
  if (r.reason) console.log(`   ${r.reason}`);
  for (const f of r.fields) console.log(`   ${f.required ? "*" : " "} ${f.action.padEnd(6)} ${f.label.slice(0, 80).padEnd(80)} ${f.shown.slice(0, 70)}${f.note ? `  (${f.note})` : ""}`);
  for (const d of r.drafts) console.log(`   DRAFT  ${d.selector}  intent=${d.intent} max=${d.maxLength ?? "-"}  ${d.label.slice(0, 200)}`);
  for (const v of r.reviews) console.log(`   REVIEW ${v.selector}  [${v.kind}] ${v.label.slice(0, 160)}  why=${v.why}  options=${v.options.slice(0, 15).join(" | ")}`);
  for (const f of r.failed) console.log(`   FAILED ${f.selector}  ${f.label.slice(0, 60)}: ${f.why}`);
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
