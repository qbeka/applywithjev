/**
 * data/queue.json: every job discovered, its rating, and its application
 * status. Statuses survive re-discovery so a job applied to yesterday is
 * never re-queued.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PATHS } from "../config.js";
import { Answer } from "../jev/types.js";
import type { FitResult } from "./rate.js";
import { jobId, type Job } from "./normalize.js";

export const QueueStatus = z.enum(["queued", "in_progress", "applied", "skipped", "failed", "blocked", "needs_review"]);
export type QueueStatus = z.infer<typeof QueueStatus>;

const JobSchema = z.object({
  id: z.string(),
  source: z.string(),
  company: z.string(),
  title: z.string(),
  url: z.string(),
  ats: z.string(),
  locations: z.array(z.string()),
  postedAt: z.string().nullable(),
  terms: z.array(z.string()),
  sponsorship: z.string(),
  degrees: z.array(z.string()),
  category: z.string().nullable(),
  description: z.string().optional(),
  descriptionSource: z.enum(["api", "html", "none"]).optional(),
});

export const QueueEntry = z.object({
  job: JobSchema,
  fit: z
    .object({
      score: z.number(),
      decision: z.enum(["apply", "below_threshold", "skip"]),
      skipReason: z.string().nullable(),
      reasons: z.array(z.string()),
      components: z.record(z.number()),
      locationTier: z.string(),
      answers: z.record(Answer),
    })
    .nullable(),
  preFilterReason: z.string().nullable(),
  status: QueueStatus,
  statusReason: z.string().nullable(),
  attempts: z.number().int(),
  discoveredAt: z.string(),
  updatedAt: z.string(),
  appliedAt: z.string().nullable(),
  notes: z.string().nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

export const QueueFile = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  entries: z.array(QueueEntry),
});
export type QueueFile = z.infer<typeof QueueFile>;

export function loadQueue(file = PATHS.queue): QueueFile {
  if (!existsSync(file)) return { version: 1, generatedAt: new Date().toISOString(), entries: [] };
  const parsed = QueueFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is corrupt: ${parsed.error.message}`);
  // An id is derived from the posting, so it is recomputed on load: a queue written by an older
  // version keeps every status, and an applied job can never come back as a new one.
  for (const e of parsed.data.entries) e.job.id = jobId(e.job.url);
  return parsed.data;
}

export function saveQueue(q: QueueFile, file = PATHS.queue): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(q, null, 2));
}

export function entryFor(job: Job, fit: FitResult | null, preFilterReason: string | null, previous?: QueueEntry): QueueEntry {
  const now = new Date().toISOString();
  const fresh: QueueEntry = {
    job: job as QueueEntry["job"],
    fit: fit as QueueEntry["fit"],
    preFilterReason,
    status: fit?.decision === "apply" ? "queued" : "skipped",
    statusReason: preFilterReason ?? fit?.skipReason ?? (fit?.decision === "below_threshold" ? `score ${fit.score} below threshold` : null),
    attempts: 0,
    discoveredAt: now,
    updatedAt: now,
    appliedAt: null,
    notes: null,
  };
  if (!previous) return fresh;
  // Keep terminal statuses and history from the previous run; refresh the job and rating.
  const terminal: QueueStatus[] = ["applied", "skipped", "failed", "blocked", "needs_review", "in_progress"];
  const keepStatus = terminal.includes(previous.status) && !(previous.status === "skipped" && fresh.status === "queued" && previous.preFilterReason);
  return {
    ...fresh,
    status: keepStatus ? previous.status : fresh.status,
    statusReason: keepStatus ? previous.statusReason : fresh.statusReason,
    attempts: previous.attempts,
    discoveredAt: previous.discoveredAt,
    appliedAt: previous.appliedAt,
    notes: previous.notes,
  };
}

/** Highest score first; ties go to the most recent posting. */
export function sortEntries(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => {
    const sa = a.fit?.score ?? -1;
    const sb = b.fit?.score ?? -1;
    if (sb !== sa) return sb - sa;
    return (b.job.postedAt ?? "").localeCompare(a.job.postedAt ?? "");
  });
}

export function updateEntry(q: QueueFile, id: string, patch: Partial<QueueEntry>): QueueEntry {
  const e = q.entries.find((x) => x.job.id === id);
  if (!e) throw new Error(`No queue entry with id ${id}`);
  Object.assign(e, patch, { updatedAt: new Date().toISOString() });
  return e;
}
