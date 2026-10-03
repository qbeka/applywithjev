/**
 * What the dashboard shows: every record as one list of plain rows, and the totals above them.
 * Pure over the rows, so the same numbers come out of a test and of the page.
 */
import { z } from "zod";
import { REPORT } from "../config.js";
import { QueueStatus } from "../jobs/queue.js";
import { takehomeRecords, toRecord, type Row } from "../log/csv.js";

export type ReportRow = ReturnType<typeof toRecord> & { takehome_link: string };

export type Report = {
  rows: ReportRow[];
  totals: { applied: number; appliedToday: number; waitingForYou: number; leftForYou: number; queued: number; skipped: number; considered: number };
  byStatus: Record<string, number>;
  byBoard: Record<string, number>;
  byDay: { day: string; applied: number }[];
  generatedAt: string;
};

export function buildReport(rows: Row[], today = new Date()): Report {
  const takehome = new Map(takehomeRecords(rows).map((t) => [t.job_id, t.takehome_link]));
  const all = rows.map((r) => ({ ...toRecord(r), takehome_link: takehome.get(r["Job ID"]) ?? "" }));
  const day = (iso: string) => iso.slice(0, 10);
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const count = (f: (r: ReportRow) => boolean) => all.filter(f).length;
  const tally = (key: (r: ReportRow) => string, only?: (r: ReportRow) => boolean) => {
    const out: Record<string, number> = {};
    for (const r of all) if (!only || only(r)) out[key(r)] = (out[key(r)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
  };
  const applied = all.filter((r) => r.status === "Applied");
  const days: Record<string, number> = {};
  for (const r of applied) if (r.applied_on) days[day(r.applied_on)] = (days[day(r.applied_on)] ?? 0) + 1;
  return {
    rows: all,
    totals: {
      applied: applied.length,
      appliedToday: applied.filter((r) => day(r.applied_on) === todayKey).length,
      waitingForYou: count((r) => /emailed you a code|not a robot/.test(`${r.status} ${r.skip_reason}`)),
      leftForYou: count((r) => /^(Needs you|Needs review|Blocked)/.test(r.status)),
      queued: count((r) => r.status === "Queued"),
      skipped: count((r) => /^Skipped/.test(r.status)),
      considered: all.length,
    },
    byStatus: tally((r) => r.status.replace(/:.*$/, "")),
    byBoard: tally((r) => r.ats || "other", (r) => r.status === "Applied"),
    byDay: Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => ({ day: d, applied: n })),
    generatedAt: new Date().toISOString(),
  };
}

/** A status change sent from the page. */
export const StatusChange = z.object({
  id: z.string().min(1).max(64),
  status: QueueStatus.refine((s) => (REPORT.statuses as readonly string[]).includes(s), "not a status the page offers").optional(),
  reason: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});
export type StatusChange = z.infer<typeof StatusChange>;
