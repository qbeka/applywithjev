/**
 * data/applications.csv: the one record of every job considered and what
 * happened. The first fifteen columns match the user's tracking sheet so
 * the file pastes straight into it; the rest are the tool's own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../config.js";
import { postingKey } from "../jobs/normalize.js";
import type { QueueEntry } from "../jobs/queue.js";

export const SHEET_COLUMNS = [
  "Company", "What They Do", "Role / Title", "Location", "Visa / Work Auth", "Job Link",
  "Contact #1 (Name / Role / LinkedIn)", "Contact #2 (Name / Role / LinkedIn)", "Contact #3 (Name / Role / LinkedIn)",
  "What to Build / Pitch Idea", "Why You're a Fit", "Response from Ref.", "Deadline", "App. Status", "Notes",
] as const;

export const EXTRA_COLUMNS = [
  "Applied On", "Fit Score", "JEV Confidence", "ATS", "Source", "Term", "Level", "Posted On", "Skip Reason", "Job ID",
] as const;

export const COLUMNS = [...SHEET_COLUMNS, ...EXTRA_COLUMNS] as const;
export type Column = (typeof COLUMNS)[number];
export type Row = Record<Column, string>;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export function emptyRow(): Row {
  return Object.fromEntries(COLUMNS.map((c) => [c, ""])) as Row;
}

export function loadRows(file = PATHS.applications): Row[] {
  if (!existsSync(file)) return [];
  const [header, ...body] = parseCsv(readFileSync(file, "utf8"));
  if (!header) return [];
  return body.map((cells) => {
    const row = emptyRow();
    header.forEach((h, i) => {
      if ((COLUMNS as readonly string[]).includes(h)) row[h as Column] = cells[i] ?? "";
    });
    return row;
  });
}

export function saveRows(rows: Row[], file = PATHS.applications): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, toCsv([[...COLUMNS], ...rows.map((r) => COLUMNS.map((c) => r[c] ?? ""))]));
}

/** Inserts or updates the row for a queue entry, keyed by Job Link, then Job ID. Hand-filled columns are preserved. */
export function upsertEntry(rows: Row[], e: QueueEntry, extra: Partial<Row> = {}): Row[] {
  // One row per posting: the same job reached by another link updates its row instead of adding one.
  const key = postingKey(e.job.url);
  const idx = rows.findIndex((r) => r["Job Link"] === e.job.url || (r["Job ID"] && r["Job ID"] === e.job.id) || (r["Job Link"] !== "" && postingKey(r["Job Link"]) === key));
  const existing = idx >= 0 ? (rows[idx] as Row) : emptyRow();
  const status = statusLabel(e);
  const fit = e.fit;
  const next: Row = {
    ...existing,
    Company: e.job.company,
    "Role / Title": e.job.title,
    Location: e.job.locations.join(" / "),
    "Visa / Work Auth": existing["Visa / Work Auth"] || workAuthLabel(e),
    "Job Link": e.job.url,
    "App. Status": status,
    Notes: existing.Notes || (fit ? fit.reasons.join("; ") : ""),
    "Applied On": e.appliedAt ? localDate(e.appliedAt) : existing["Applied On"],
    "Fit Score": fit ? fit.score.toFixed(3) : "",
    "JEV Confidence": fit ? avgConfidence(fit).toFixed(2) : "",
    ATS: e.job.ats,
    Source: e.job.source,
    Term: termLabel(e),
    Level: fit ? ((fit.answers.level as { choice?: string } | undefined)?.choice ?? "") : "",
    "Posted On": e.job.postedAt ?? "",
    "Skip Reason": e.status === "skipped" || e.status === "blocked" || e.status === "failed" ? (e.statusReason ?? "") : "",
    "Job ID": e.job.id,
    ...extra,
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return rows;
}

/** The calendar day where the candidate is, not the UTC day: an application sent at 10pm belongs to today. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function statusLabel(e: QueueEntry): string {
  switch (e.status) {
    case "applied": return "Applied";
    case "queued": return "Queued";
    case "in_progress": return "In progress";
    case "needs_review": return "Needs review";
    case "blocked": return `Blocked: ${e.statusReason ?? ""}`.trim();
    case "failed": return `Failed: ${e.statusReason ?? ""}`.trim();
    case "skipped": return `Skipped: ${e.statusReason ?? ""}`.trim();
  }
}

function workAuthLabel(e: QueueEntry): string {
  const a = e.fit?.answers.work_auth as { choice?: string } | undefined;
  switch (a?.choice) {
    case "canada_ok": return "Canada. No visa needed.";
    case "us_sponsors": return "US. Sponsorship offered.";
    case "us_no_sponsorship": return "US. No sponsorship.";
    case "us_citizenship_required": return "US citizenship required.";
    case "remote_global": return "Remote, any country.";
    default: return e.fit ? "Not stated." : "";
  }
}

function termLabel(e: QueueEntry): string {
  // What the source list says (Summer 2027) reads better than the rating's own key (summer).
  if (e.job.terms.length) return e.job.terms.join(", ");
  const a = e.fit?.answers.term as { choice?: string } | undefined;
  return (a?.choice ?? "").replace(/_/g, " ");
}

function avgConfidence(fit: NonNullable<QueueEntry["fit"]>): number {
  const vals = Object.values(fit.answers)
    .map((a) => ("confidence" in a ? a.confidence : null))
    .filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
