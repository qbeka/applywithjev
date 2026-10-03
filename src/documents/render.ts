/**
 * The tailored documents as pages: plain HTML with system fonts, printed to PDF by the runner's
 * own Chrome over the DevTools protocol. No LaTeX, no library. Everything from the profile and
 * the writer is escaped before it reaches the page.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BROWSER, DOCUMENTS, PATHS } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import type { Tailored } from "./tailor.js";

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const STYLE = `
  @page { size: ${DOCUMENTS.paper.width}in ${DOCUMENTS.paper.height}in; margin: 0.6in 0.7in; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0; letter-spacing: 0.2px; }
  .headline { font-size: 11pt; color: #333; margin: 2px 0 4px; }
  .contact { font-size: 9.5pt; color: #444; margin-bottom: 10px; }
  .contact a { color: #444; text-decoration: none; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.8px; border-bottom: 1px solid #999; padding-bottom: 2px; margin: 12px 0 6px; }
  p { margin: 0 0 6px; }
  ul { margin: 2px 0 6px; padding-left: 16px; }
  li { margin: 0 0 2px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; }
  .row .where { color: #333; }
  .row .when { color: #555; font-size: 9.5pt; white-space: nowrap; margin-left: 10px; }
  .skills { margin: 0; }
  .letter p { margin: 0 0 10px; }
  .letter .date { color: #555; margin-bottom: 14px; }
  .letter .sig { margin-top: 18px; }
`;

const contactLine = (profile: Profile) => {
  const bits = [profile.email, `${profile.phone.countryCode} ${profile.phone.national}`, `${profile.address.city}, ${profile.address.regionCode || profile.address.region}`];
  const links = Object.entries(profile.links ?? {}).filter(([, v]) => typeof v === "string" && v) as [string, string][];
  for (const [, url] of links) bits.push(url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
  return bits.map(escapeHtml).join(" &middot; ");
};

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

export function resumeHtml(profile: Profile, t: Tailored): string {
  const name = `${profile.name.first} ${profile.name.last}`;
  const exp = t.experience
    .map((e) => {
      const src = profile.experience.find((x) => x.company.toLowerCase().includes(e.company.toLowerCase()) || e.company.toLowerCase().includes(x.company.toLowerCase()));
      const when = src ? `${src.start} to ${src.current ? "present" : src.end}` : "";
      return `<div class="row"><div><strong>${escapeHtml(e.title)}</strong>, <span class="where">${escapeHtml(e.company)}${src?.location ? `, ${escapeHtml(src.location)}` : ""}</span></div><div class="when">${escapeHtml(when)}</div></div><ul>${e.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
    })
    .join("");
  const projects = t.projects
    .map((p) => {
      const src = profile.projects.find((x) => x.name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(x.name.toLowerCase()));
      const link = src?.link ? ` <span class="where">${escapeHtml(src.link.replace(/^https?:\/\/(www\.)?/, ""))}</span>` : "";
      return `<div class="row"><div><strong>${escapeHtml(p.name)}</strong>${src?.role ? `, <span class="where">${escapeHtml(src.role)}</span>` : ""}${link}</div><div class="when">${escapeHtml(src ? `${src.start} to ${src.end}` : "")}</div></div><ul>${p.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
    })
    .join("");
  const education = profile.education
    .map((e) => `<div class="row"><div><strong>${escapeHtml(e.degree)}, ${escapeHtml(e.field)}</strong>${e.minor ? `, minor in ${escapeHtml(e.minor)}` : ""}, <span class="where">${escapeHtml(e.school)}</span></div><div class="when">${e.status === "in_progress" ? "expected " : ""}${escapeHtml(String(e.gradYear))}</div></div>`)
    .join("");
  return page(
    `${name} resume`,
    `<h1>${escapeHtml(name)}</h1><div class="headline">${escapeHtml(t.headline)}</div><div class="contact">${contactLine(profile)}</div>` +
      `<p>${escapeHtml(t.summary)}</p>` +
      `<h2>Skills</h2><p class="skills">${t.skills.map(escapeHtml).join(" &middot; ")}</p>` +
      `<h2>Experience</h2>${exp}` +
      (projects ? `<h2>Projects</h2>${projects}` : "") +
      `<h2>Education</h2>${education}`,
  );
}

export function coverHtml(profile: Profile, entry: QueueEntry, t: Tailored): string {
  const letter = t.coverLetter;
  if (!letter) throw new Error("no cover letter was written");
  const name = `${profile.name.first} ${profile.name.last}`;
  // The page prints the name under the closing, so a closing that already ends in the name loses it there.
  const stripped = letter.closing.replace(new RegExp(`[,\\s]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?\\s*$`, "i"), "").trim();
  const closing = stripped ? (stripped.endsWith(",") ? stripped : `${stripped},`) : "Sincerely,";
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return page(
    `${name} cover letter`,
    `<div class="letter"><h1>${escapeHtml(name)}</h1><div class="contact">${contactLine(profile)}</div>` +
      `<div class="date">${escapeHtml(today)}</div>` +
      `<p>${escapeHtml(entry.job.company)}<br>${escapeHtml(entry.job.title)}</p>` +
      `<p>${escapeHtml(letter.greeting)}</p>` +
      letter.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
      `<p class="sig">${escapeHtml(closing)}<br>${escapeHtml(name)}</p></div>`,
  );
}

/** How many pages a PDF holds, from its page objects. Enough to tell one page from two. */
export const pdfPages = (pdf: Buffer) => Math.max(1, (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length);

/**
 * Prints an HTML document to a PDF file and returns its page count. A headless Chrome of its own
 * does the printing: the runner's window cannot print, and nothing else needs installing. The
 * HTML is written next to the PDF while Chrome reads it, then removed.
 */
export async function printPdf(html: string, outFile: string): Promise<number> {
  const htmlFile = outFile.replace(/\.pdf$/, "") + ".html";
  writeFileSync(htmlFile, html);
  if (existsSync(outFile)) unlinkSync(outFile);
  // Chrome writes the PDF and may then linger, so the file is watched and Chrome is stopped once it is whole.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(BROWSER.chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-pdf-header-footer", `--print-to-pdf=${outFile}`, `--user-data-dir=${path.join(PATHS.runs, "print-profile")}`, `file://${htmlFile}`], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    let done = false;
    const finish = (fail?: Error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (fail) reject(fail);
      else resolve();
    };
    let lastSize = -1;
    const poll = setInterval(() => {
      if (!existsSync(outFile)) return;
      const size = statSync(outFile).size;
      if (size > 0 && size === lastSize) finish();
      lastSize = size;
    }, 200);
    const timer = setTimeout(() => finish(new Error("printing did not finish in time")), DOCUMENTS.printTimeoutMs);
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => finish(new Error(`could not run Chrome to print: ${e.message}`)));
    child.on("close", () => {
      if (existsSync(outFile) && statSync(outFile).size > 0) finish();
      else finish(new Error(`printing failed${err ? `: ${err.trim().split("\n").pop()?.slice(0, 160)}` : ""}`));
    });
  });
  unlinkSync(htmlFile);
  return pdfPages(readFileSync(outFile));
}
