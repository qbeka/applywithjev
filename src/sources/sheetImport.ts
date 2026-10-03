/**
 * Reads a CSV export of the user's tracking sheet (the same fifteen columns
 * as applications/all.csv) and turns rows that are not yet applied into
 * jobs for the pipeline.
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "../log/csv.js";
import { atsFromUrl, canonicalUrl, jobId, type Job } from "../jobs/normalize.js";

export function parseSheetCsv(text: string): Job[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const col = (name: RegExp) => header.findIndex((h) => name.test(h));
  const iCompany = col(/^company/i);
  const iTitle = col(/role|title/i);
  const iLocation = col(/^location/i);
  const iLink = col(/job link|link|url/i);
  const iStatus = col(/status/i);
  if (iCompany < 0 || iLink < 0) throw new Error("Sheet CSV needs at least Company and Job Link columns");
  const out: Job[] = [];
  for (const r of rows) {
    const link = (r[iLink] ?? "").trim();
    if (!/^https?:\/\//.test(link)) continue;
    const status = (iStatus >= 0 ? r[iStatus] ?? "" : "").toLowerCase();
    if (/^applied|rejected|offer|interview|withdrawn/.test(status)) continue;
    const url = canonicalUrl(link);
    out.push({
      id: jobId(url),
      source: "sheet",
      company: (r[iCompany] ?? "").trim(),
      title: (iTitle >= 0 ? r[iTitle] ?? "" : "").trim(),
      url,
      ats: atsFromUrl(url),
      locations: (iLocation >= 0 ? r[iLocation] ?? "" : "").split(/\s*\/\s*|;/).map((s) => s.trim()).filter(Boolean),
      postedAt: null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: null,
    });
  }
  return out;
}

export function importSheet(file: string): Job[] {
  return parseSheetCsv(readFileSync(file, "utf8"));
}
