/**
 * The apply loop. Each job moves on its own through fill, resolve, the next
 * page if the form has one, and submit. Nothing waits for the batch: a form is
 * sent the moment it is ready, and its result is printed and recorded then.
 * Fills run side by side and paced per site, the writer takes a few forms at
 * a time, and submissions go one at a time with a pause per site.
 */
import { RUN } from "../config.js";
import { ensureBrowser } from "../browser/cdp.js";
import { fillJob, nextPage, resolveJob, shouldAdvance } from "../browser/formRunner.js";
import { blockedReport, loadReport, type FillReport } from "../browser/report.js";
import { closeJobTab } from "../browser/session.js";
import { submitJob } from "../browser/submit.js";
import { logNotes } from "../answers/resolve.js";
import { JevClient } from "../jev/client.js";
import { applyUrlFor, type Job } from "../jobs/normalize.js";
import { loadQueue, nextQueued, saveQueue, sortEntries, updateEntry, type QueueEntry } from "../jobs/queue.js";
import { rememberWalledHost } from "../jobs/walled.js";
import { learn, loadKnowledge } from "../knowledge/sites.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import { loadProfile, type Profile } from "../profile/schema.js";
import { limiter, paced, spacer } from "../util/pace.js";
import { outcomeOf } from "./outcome.js";
import { printFill } from "./print.js";

export type RunOptions = { submit: boolean; dry: boolean; fresh: boolean; quiet: boolean; fillOnly?: boolean };

const asJob = (e: QueueEntry) => e.job as unknown as Job;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** The jobs a run works on: the given ids, or the best queued ones. A real run marks them in progress; a rehearsal leaves the queue alone. */
export function takeJobs(ids: string[], o: { count: number; dry: boolean }): QueueEntry[] {
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

/** Records an outcome in the queue and in the record files. */
export function record(id: string, status: QueueEntry["status"], reason: string | null, extra: Partial<Record<"What They Do" | "Why You're a Fit" | "Notes", string>> = {}): QueueEntry {
  const q = loadQueue();
  const e = updateEntry(q, id, { status, statusReason: reason, ...(status === "applied" ? { appliedAt: new Date().toISOString() } : {}) });
  saveQueue(q);
  saveRows(upsertEntry(loadRows(), e, extra));
  return e;
}

/** Set when a fill was abandoned. Its page connection may still be open, so a command ends the process itself when it is done. */
let abandoned = false;
export const endIfAbandoned = () => {
  if (abandoned) process.exit(process.exitCode ?? 0);
};

/** One go at a form, within RUN.fillTimeoutMs. A form that cannot be opened, or never settles, comes back as blocked. */
async function fillOnce(jev: JevClient, profile: Profile, e: QueueEntry): Promise<FillReport> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the form did not finish loading and filling in ${RUN.fillTimeoutMs / 1000}s`)), RUN.fillTimeoutMs);
    });
    const filling = fillJob(jev, profile, asJob(e));
    // If the time runs out, the fill is abandoned: its tab is closed below, and whatever it does afterwards is ignored.
    filling.catch(() => undefined);
    return await Promise.race([filling, tooLong]);
  } catch (err) {
    if (err instanceof Error && /did not finish loading/.test(err.message)) {
      abandoned = true;
      await closeJobTab(e.job.id).catch(() => undefined);
    }
    return blockedReport(e.job, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** A form whose values did not land on its first page is worth one more go: a page that loaded badly is often fine the second time. */
const worthAnotherGo = (r: FillReport) => r.state === "filled" && r.page === 1 && !r.stuck && r.failed.length > 0;

/** Settles what JEV left open on the page a job's tab shows: from the answer memory, or by Claude. A writer error leaves the form as it was. */
export async function resolvePage(jev: JevClient, profile: Profile, entry: QueueEntry | null, r: FillReport, fresh: boolean): Promise<FillReport> {
  try {
    return await resolveJob(profile, entry, r.jobId, { jev, fresh });
  } catch (err) {
    return { ...r, ready: false, reason: `writer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const CODE_PREFIX = "the board emailed you a code";
const CODE_REASON = `${CODE_PREFIX} to confirm a person is applying. The filled form is open in the tool's window: type the code, click Submit, then run: codes`;

/**
 * Submissions to one site are spaced out, and only one form is being sent at any moment. A burst
 * from one person reads as a robot. A site known to answer bursts with an emailed code gets a longer pause.
 */
const perSite = spacer((site) => (Object.entries(loadKnowledge().sites).some(([host, s]) => s.emailsCode && host.endsWith(site)) ? RUN.submitGapAfterCodeMs : RUN.submitGapMs));
const oneAtATime = limiter(1);
const siteOf = (id: string) => {
  try {
    return hostOf(loadReport(id).url).split(".").slice(-2).join(".");
  } catch {
    return id;
  }
};

/** Sends one ready form and records what the page became. True when the application went through. */
export function submitAndRecord(jev: JevClient, id: string, force: boolean, keepOpen = false): Promise<boolean> {
  return perSite(siteOf(id), () =>
    oneAtATime(async () => {
      try {
        const r = await submitJob(jev, id, force);
        console.log(`${id}  ${r.needsCode ? "needs your code" : r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
        if (r.state === "submitted") {
          record(id, "applied", null);
          if (!keepOpen) await closeJobTab(id);
          return true;
        }
        if (r.needsCode) {
          // Only the person can pass a human check. The tab stays open, filled, for them.
          record(id, "needs_review", CODE_REASON);
          learn(r.url, { emailsCode: true });
          return false;
        }
        if (r.errors.length) console.log(`  errors: ${r.errors.join(" | ")}`);
        console.log(`  page: ${r.excerpt}`);
        record(id, r.state === "captcha" || r.state === "login_required" ? "blocked" : "needs_review", `after submit the page was: ${r.state}${r.errors.length ? ` (${r.errors.slice(0, 3).join("; ").slice(0, 160)})` : ""}`);
        if (!keepOpen) await closeJobTab(id);
      } catch (err) {
        console.log(`${id}  not submitted: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }),
  );
}

/**
 * Fills the two sheet cells a person would otherwise write by hand, for every job just applied to.
 * A form Claude resolved already carries its note. The rest are written in one writer call.
 */
export async function noteApplied(ids: string[]): Promise<void> {
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

/** Takes a form from its filled first page to its last: each page resolved, then the form's own Next. */
async function walk(jev: JevClient, profile: Profile, e: QueueEntry, first: FillReport, o: RunOptions): Promise<FillReport> {
  let r = first;
  for (;;) {
    r = await resolvePage(jev, profile, e, r, o.fresh);
    if (!shouldAdvance(r)) return r;
    r = await nextPage(jev, profile, asJob(e), { dry: o.dry });
  }
}

/** Records what became of one job, and sends its form when it is ready and sending was asked for. True when the application went through. */
async function settle(jev: JevClient, r: FillReport, o: RunOptions): Promise<boolean> {
  const outcome = outcomeOf(r, RUN.maxPages);
  // What this form taught about its site: how many pages it has, and whether it ended ready. A rehearsal teaches the same.
  if (r.state === "filled" && !o.fillOnly) learn(r.url, { pages: r.page, form: { ready: outcome.action === "send" } });
  if (o.dry) {
    await closeJobTab(r.jobId);
    return false;
  }
  if (o.fillOnly) return false;
  if (outcome.action === "send") return o.submit ? submitAndRecord(jev, r.jobId, false) : false;
  const rec = record(r.jobId, outcome.action, outcome.reason);
  if (outcome.rememberSite) rememberWalledHost(rec.job.url);
  // A form the tool cannot finish is closed in a sending run: it is on the by-hand list with its link.
  if (outcome.action !== "needs_review" || o.submit) await closeJobTab(r.jobId);
  return outcome.action === "applied";
}

export async function pipeline(entries: QueueEntry[], o: RunOptions): Promise<{ reports: FillReport[]; sent: string[] }> {
  const profile = loadProfile();
  const jev = new JevClient();
  await ensureBrowser();
  const writer = limiter(RUN.writerConcurrency);
  const reports = new Array<FillReport>(entries.length);
  const sent: string[] = [];
  const after: Promise<void>[] = [];
  /** Jobs to fill once more when the rest are done, each with the window to itself. */
  const again: QueueEntry[] = [];
  const finish = async (e: QueueEntry, r: FillReport) => {
    reports[entries.indexOf(e)] = r;
    if (!o.quiet) printFill(r);
    if (await settle(jev, r, o)) sent.push(r.jobId);
  };
  await paced(entries, (e) => hostOf(applyUrlFor(asJob(e))), async (e) => {
    const first = await fillOnce(jev, profile, e);
    reports[entries.indexOf(e)] = first;
    // The rest of this job's path does not hold a fill slot: the next form starts filling now.
    after.push(
      (async () => {
        const r = o.fillOnly ? first : await writer(() => walk(jev, profile, e, first, o));
        if (RUN.fillAttempts > 1 && worthAnotherGo(r)) again.push(e);
        else await finish(e, r);
      })().catch((err) => console.log(`${e.job.id}  ${err instanceof Error ? err.message : String(err)}`)),
    );
    return first;
  });
  await Promise.all(after);
  // Some boxes only take a value while their tab keeps the window: a phone box on a page that is still loading its own
  // checker, for one. With five forms side by side no tab keeps it for long. These forms are filled again, one at a time.
  for (const e of again) {
    try {
      const first = await fillOnce(jev, profile, e);
      await finish(e, o.fillOnly ? first : await walk(jev, profile, e, first, o));
    } catch (err) {
      console.log(`${e.job.id}  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { reports, sent };
}
