/**
 * Opens a job's application form in the runner's Chrome window and fills it:
 * dump every field, read each dropdown's options, one JEV call to map them,
 * then write every value with real input events and attach the resume.
 * Nothing here submits. Submit is a separate command the user triggers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BROWSER, FORM, PATHS } from "../config.js";
import { FieldsDump, isApplicationForm, type DumpedField, type FillPlan } from "../forms/fields.js";
import { hasChoosableOptions, mapForm } from "../forms/mapForm.js";
import { decidePageState, type PageState } from "../forms/pageState.js";
import type { JevClient } from "../jev/client.js";
import { applyUrlFor, greenhouseFallbackUrl, type Job } from "../jobs/normalize.js";
import type { Profile } from "../profile/schema.js";
import { resolveOpenFields, type OpenField, type Resolution } from "../answers/resolve.js";
import type { QueueEntry } from "../jobs/queue.js";
import { closeTab, ensureBrowser, listTargets, newTab, Page, sleep } from "./cdp.js";

const script = (name: string) => readFileSync(path.join(PATHS.browserScripts, name), "utf8");
const SESSION = path.join(PATHS.runs, "browser-session.json");

/** The text of a button that leads from a posting to its form. */
const APPLY_BUTTON = "^\\s*(apply|apply now|apply for this job|apply to this job|apply for this position|start application|i'm interested)\\s*$";

type Session = Record<string, { targetId: string; url: string }>;
type Point = { x: number; y: number; ok: boolean };
export type Fill = { selector: string; kind: string; value: string };
export type FieldReport = { label: string; required: boolean; action: string; shown: string; note: string | null };
export type FillReport = {
  jobId: string;
  company: string;
  title: string;
  ats: string;
  url: string;
  state: "filled" | "blocked";
  reason: string | null;
  fields: FieldReport[];
  drafts: FillPlan["drafts"];
  reviews: FillPlan["reviews"];
  failed: { selector: string; label: string; why: string }[];
  missingRequired: string[];
  /** True when nothing is left open: every wanted value is on the page and no required field is empty. Only a ready form may be submitted. */
  ready: boolean;
  /** What Claude decided about the fields JEV left open, once resolve has run. */
  resolution?: Resolution;
  seconds: number;
  jevCostUsd: number;
};

const reportFile = (jobId: string) => path.join(PATHS.runs, `${jobId}.report.json`);
const planFile = (jobId: string) => path.join(PATHS.runs, `${jobId}.plan.json`);
function saveReport(r: FillReport): FillReport {
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(reportFile(r.jobId), JSON.stringify(r, null, 2));
  return r;
}
export function loadReport(jobId: string): FillReport {
  if (!existsSync(reportFile(jobId))) throw new Error(`No fill report for job ${jobId}. Run fill first.`);
  return JSON.parse(readFileSync(reportFile(jobId), "utf8")) as FillReport;
}
/**
 * Required fields the page shows empty. A group of checkboxes that share a name is one question:
 * it is answered once any box in it is ticked, so the unticked ones are not missing.
 */
function emptyRequired(d: FieldsDump, plan: FillPlan, shown: string[], states: ControlState[]): string[] {
  const nameOf = new Map(d.fields.map((f) => [f.selector, f.kind === "checkbox" ? f.name : ""]));
  const answeredGroups = new Set(plan.fields.filter((f, i) => f.kind === "checkbox" && shown[i]).map((f) => nameOf.get(f.selector)).filter((n): n is string => !!n));
  return plan.fields
    .filter((f, i) => f.required && !shown[i] && states[i] !== "off" && f.action !== "upload" && !(f.kind === "checkbox" && answeredGroups.has(nameOf.get(f.selector) ?? "")))
    .map((f) => f.label);
}

const isReady = (r: Pick<FillReport, "state" | "drafts" | "reviews" | "failed" | "missingRequired">) => r.state === "filled" && !r.drafts.length && !r.reviews.length && !r.failed.length && !r.missingRequired.length;

const loadSession = (): Session => (existsSync(SESSION) ? (JSON.parse(readFileSync(SESSION, "utf8")) as Session) : {});
const saveSession = (s: Session) => {
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(SESSION, JSON.stringify(s, null, 2));
};
/** Step timings on stderr when AWJ_TRACE is set. */
const trace = (line: string) => {
  if (process.env.AWJ_TRACE) console.error(`[fill] ${line}`);
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

async function install(page: Page): Promise<void> {
  await page.evaluate(script("pageHelpers.js"));
}

/** Waits until the document is loaded and its form controls stop changing. A page with no controls yet gets longer: single-page forms render late. */
async function settle(page: Page): Promise<void> {
  const started = Date.now();
  let last = -2;
  let stable = 0;
  while (Date.now() - started < BROWSER.settleMs) {
    await sleep(BROWSER.pollMs);
    let n = -1;
    try {
      // "interactive" is enough: a tracker or a font that never finishes loading must not hold the form up.
      n = await page.evaluate<number>("document.readyState !== 'loading' ? document.querySelectorAll('input, select, textarea').length : -1");
    } catch {
      n = -1; // mid-navigation
    }
    stable = n >= 0 && n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 3 && (n >= 3 || Date.now() - started > BROWSER.emptyPageMs)) break;
  }
  trace(`settled in ${Date.now() - started}ms with ${last} controls`);
}

async function dump(page: Page): Promise<FieldsDump> {
  return FieldsDump.parse(JSON.parse(await page.evaluate<string>(script("dumpFields.js"))));
}

async function goto(page: Page, url: string): Promise<void> {
  await page.navigate(url);
  await settle(page);
  await install(page);
}

/** Lands on the page that holds the form: the URL itself, an embedded ATS frame, or behind an Apply button. */
async function openForm(page: Page, job: Job): Promise<FieldsDump> {
  await goto(page, applyUrlFor(job));
  let d = await dump(page);
  for (let hop = 0; hop < 3 && !isApplicationForm(d); hop++) {
    const frame = d.frames[0];
    if (frame) {
      await goto(page, frame);
    } else {
      const p = await page.awj<Point>("clickByText", APPLY_BUTTON);
      if (!p.ok) break;
      await page.click(p.x, p.y);
      await settle(page);
      await install(page);
    }
    d = await dump(page);
  }
  // A careers page that shows the job without the form: go to the board's own form for the same posting.
  const fallback = !isApplicationForm(d) && !d.hasPassword ? greenhouseFallbackUrl(job) : null;
  if (fallback) {
    await goto(page, fallback);
    d = await dump(page);
  }
  return d;
}

/** Polls an open dropdown until its options settle, or until `enough` says the wanted one has arrived. */
async function waitOptions(page: Page, selector: string, typed: boolean, enough?: (opts: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + (typed ? BROWSER.optionsMs : BROWSER.optionsMs / 4);
  const clean = (opts: string[]) => opts.filter((o) => !/^(loading|searching|no options|no results|type to search)/i.test(o));
  let last = "";
  let stable = 0;
  let opts: string[] = [];
  while (Date.now() < deadline) {
    await sleep(BROWSER.pollMs);
    opts = clean(await page.awj<string[]>("options", selector));
    if (enough) {
      if (enough(opts)) break;
      continue;
    }
    const sig = opts.join("|");
    stable = opts.length > 0 && sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= 1) break;
  }
  return opts;
}

/**
 * Picks the option that matches the wanted value. Among several matches, the one that names the
 * candidate's own city, region or country wins. A location like "Edmonton, Alberta, Canada" also
 * matches "Edmonton, AB, Canada": same first part, and at least one of the candidate's places named.
 * Returns null rather than something merely similar.
 */
export function pickOption(options: string[], value: string, hints: string[]): string | null {
  const want = norm(value);
  if (!want) return null;
  const word = (h: string) => new RegExp(`(^|[^a-z0-9])${norm(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  const score = (o: string) => hints.filter((h) => h && word(h).test(norm(o))).length;
  const best = (pool: string[]) => [...pool].sort((a, b) => score(b) - score(a) || a.length - b.length)[0] ?? null;
  const exact = options.filter((o) => norm(o) === want);
  const starts = options.filter((o) => norm(o).startsWith(want));
  const includes = options.filter((o) => norm(o).includes(want));
  const pool = exact.length ? exact : starts.length ? starts : includes;
  if (pool.length) return best(pool);
  const head = norm(value.split(",")[0] ?? "");
  if (!head || head === want) return null;
  // The city alone proves nothing (there is an Edmonton in Kentucky): a region or country of the candidate's must be named too.
  const beyondHead = hints.filter((h) => h && norm(h) !== head);
  const sameHead = options.filter((o) => norm(o.split(",")[0] ?? "") === head && beyondHead.some((h) => word(h).test(norm(o))));
  return best(sameHead);
}

async function openDropdown(page: Page, selector: string): Promise<boolean> {
  const p = await page.awj<Point>("point", selector);
  if (!p.ok) return false;
  await page.click(p.x, p.y);
  return true;
}

async function closeDropdown(page: Page): Promise<void> {
  await page.key("Escape");
  await page.evaluate("window.__awj.blur()");
}

/** Reads the options of one dropdown that only renders them once opened. */
async function readOptions(page: Page, selector: string): Promise<string[]> {
  const react = () => page.awj<string[] | null>("reactOptions", selector);
  const opts = await react();
  if (opts?.length) return opts;
  if (opts !== null) {
    // A react-select with a lazy list: ask its own loader, or open it through its handler and watch.
    const viaLoader = await page.awj<string[] | null>("reactLoad", selector, "").catch(() => null);
    if (viaLoader?.length) return viaLoader;
    if (!(await page.awj<boolean>("reactMenu", selector, true))) return [];
    const deadline = Date.now() + BROWSER.optionsMs / 2;
    let loaded: string[] = [];
    while (!loaded.length && Date.now() < deadline) {
      await sleep(BROWSER.pollMs);
      loaded = (await react()) ?? [];
    }
    await page.awj("reactMenu", selector, false);
    return loaded;
  }
  return inFront(page, async () => {
    if (!(await openDropdown(page, selector))) return [];
    const seen = await waitOptions(page, selector, false);
    await closeDropdown(page);
    return seen;
  });
}

/** Gives every dropdown its real options, so JEV chooses among them. Long lists (countries, schools) are searched by typing instead. */
async function readDropdownOptions(page: Page, fields: DumpedField[]): Promise<void> {
  await Promise.all(
    fields
      .filter((f) => f.kind === "combobox" && f.options.length === 0)
      .map(async (f) => {
        const opts = await readOptions(page, f.selector);
        if (opts.length > 0 && opts.length <= FORM.maxOptionsForJev) f.options = opts.map((o) => ({ value: o, label: o }));
      }),
  );
}

/** Sets a react-select through its own handler: no clicks, no waiting on menus. Null when it cannot. */
async function fillDropdownDirect(page: Page, selector: string, value: string, hints: string[]): Promise<boolean | null> {
  const read = () => page.awj<string[] | null>("reactOptions", selector);
  let opts = await read();
  if (opts === null) return null;
  let choice = pickOption(opts, value, hints);
  if (!choice) {
    // A paginated list answers a search through its own loader in one round trip.
    const found = await page.awj<string[] | null>("reactLoad", selector, value).catch(() => null);
    choice = found ? pickOption(found, value, hints) : null;
  }
  if (!choice) {
    // A search-as-you-type list only loads while its menu counts as open, and it has to see that before the search text arrives.
    await page.awj("reactMenu", selector, true);
    await sleep(BROWSER.pollMs);
  }
  // A place is searched by its city first; anything else by the full value.
  const head = value.split(",")[0]?.trim() ?? "";
  for (const typed of choice ? [] : [...new Set(head && head !== value ? [head, value] : [value])]) {
    if (!(await page.awj<boolean>("reactSearch", selector, typed))) break;
    const begun = Date.now();
    let asked = 1;
    while (!choice && Date.now() - begun < BROWSER.optionsMs) {
      await sleep(BROWSER.pollMs);
      opts = (await read()) ?? [];
      choice = pickOption(opts, value, hints);
      // A search sent while the component was still mounting is dropped, so ask once more halfway through.
      if (!choice && !opts.length && asked === 1 && Date.now() - begun > BROWSER.optionsMs / 2) {
        asked = 2;
        await page.awj("reactSearch", selector, typed);
      }
    }
    if (choice) break;
    // Leave the search box empty again, so a fallback that types starts clean.
    await page.awj("reactSearch", selector, "");
  }
  if (!choice) await page.awj("reactMenu", selector, false);
  if (!choice) return false;
  return page.awj<boolean>("reactSelect", selector, choice);
}

async function fillDropdown(page: Page, selector: string, value: string, hints: string[]): Promise<string | null> {
  const direct = await fillDropdownDirect(page, selector, value, hints);
  if (direct) return null;
  // The component itself said it has no such option, so typing the same text into it would only be slower.
  if (direct === false) return `no option matches "${value}"`;
  return fillDropdownByClicking(page, selector, value, hints);
}

/** Clicks and typing need the tab in front, so tabs filled side by side take turns for them. */
let turn: Promise<unknown> = Promise.resolve();
function inFront<T>(page: Page, work: () => Promise<T>): Promise<T> {
  const run = turn.then(async () => {
    await page.bringToFront();
    return work();
  });
  turn = run.catch(() => undefined);
  return run;
}

function fillDropdownByClicking(page: Page, selector: string, value: string, hints: string[]): Promise<string | null> {
  return inFront(page, () => clickAndPick(page, selector, value, hints));
}

async function clickAndPick(page: Page, selector: string, value: string, hints: string[]): Promise<string | null> {
  if (!(await openDropdown(page, selector))) return "control not found";
  let opts = await waitOptions(page, selector, false);
  let choice = pickOption(opts, value, hints);
  if (!choice) {
    // Search-as-you-type lists. A place is searched by its city; anything else by the full value, then its first word.
    const head = value.split(",")[0]?.trim() ?? "";
    const attempts = head && head !== value ? [head, value] : [value, value.split(/\s+/)[0] ?? ""];
    for (const typed of [...new Set(attempts)]) {
      if (!typed) continue;
      await page.type(typed);
      // The first word only widens the search. The pick still has to match the whole value.
      opts = await waitOptions(page, selector, true, (seen) => pickOption(seen, value, hints) !== null);
      choice = pickOption(opts, value, hints);
      if (choice) break;
      for (let i = 0; i < typed.length; i++) await page.key("Backspace");
    }
  }
  if (!choice) {
    await closeDropdown(page);
    return `no option matches "${value}"${opts.length ? ` among: ${opts.slice(0, 12).join(" | ")}` : ""}`;
  }
  const p = await page.awj<Point>("optionPoint", selector, choice);
  if (!p.ok) {
    await closeDropdown(page);
    return `option "${choice}" could not be clicked`;
  }
  await page.click(p.x, p.y);
  await sleep(BROWSER.pollMs);
  return null;
}

/** Applies fills to the open form. Returns the ones that did not land. */
export async function applyFills(page: Page, fills: Fill[], profile: Profile): Promise<{ selector: string; why: string }[]> {
  const failed: { selector: string; why: string }[] = [];
  const hints = [profile.address.city, profile.address.region, profile.address.regionCode, profile.address.country];
  // fillFields.js is a function expression under a comment header; the protocol wants the bare expression.
  const fillScript = script("fillFields.js").replace(/^(\s*\/\/.*\n)+/, "").trim().replace(/;$/, "");
  const setFields = async (some: Fill[]) => {
    if (!some.length) return;
    const report = JSON.parse(await page.call<string>(fillScript, some)) as { failed: { selector: string; why: string }[] };
    for (const f of report.failed) if (!failed.some((x) => x.selector === f.selector)) failed.push(f);
  };
  const simple = fills.filter((f) => f.kind !== "combobox");
  page.takeWrites();
  const [first, ...rest] = simple;
  if (first) {
    await setFields([first]);
    await sleep(BROWSER.pollMs);
  }
  if (page.takeWrites().made > 0) {
    // This form saves each field to its server as it changes (Ashby). Fields go in one at a time,
    // each waiting for its save, because a burst of saves gets dropped and the form then submits half empty.
    await page.writesSettled(BROWSER.saveMs);
    for (const f of rest) {
      await setFields([f]);
      await sleep(BROWSER.pollMs / 3);
      await page.writesSettled(BROWSER.saveMs);
    }
  } else {
    await setFields(rest);
  }
  for (const f of fills.filter((x) => x.kind === "combobox")) {
    const t = Date.now();
    const why = await fillDropdown(page, f.selector, f.value, hints);
    if (why) failed.push({ selector: f.selector, why });
    await page.writesSettled(BROWSER.saveMs);
    trace(`dropdown ${f.selector} ${Date.now() - t}ms${why ? ` failed: ${why}` : ""}`);
  }
  // A save the server refused means the value is on the page but not in the application.
  const refused = page.takeWrites().failed;
  if (refused.length) {
    trace(`the form's own saves failed: ${refused.join(" | ")}`);
    await sleep(BROWSER.retryAfterMs / 2);
    for (const f of simple) {
      // Set to something else first: an unchanged value would not be saved again.
      if (TYPED_KINDS.has(f.kind)) await setFields([{ ...f, value: "" }]);
      await setFields([f]);
      await sleep(BROWSER.pollMs);
      await page.writesSettled(BROWSER.saveMs);
    }
    const again = page.takeWrites().failed;
    if (again.length) failed.push({ selector: fills[0]?.selector ?? "form", why: `the form's own server refused ${again.length} save(s): ${again[0]}` });
  }
  await page.evaluate("window.__awj.blur()");
  // Trust nothing: read every control back. A value that did not stick gets one retry with real clicks and typing.
  await sleep(BROWSER.pollMs);
  const shown = await shownValues(page, fills.map((f) => f.selector));
  const states = await controlStates(page, fills.map((f) => f.selector));
  for (const [i, f] of fills.entries()) {
    if (states[i] === "off") {
      // The form switched this control off after another answer (an end date once "still a student" is ticked).
      const at = failed.findIndex((x) => x.selector === f.selector);
      if (at >= 0) failed.splice(at, 1);
      continue;
    }
    if (states[i] === "missing") {
      // Not the same as switched off: the page changed under the selector, so the value is unconfirmed.
      if (!failed.some((x) => x.selector === f.selector)) failed.push({ selector: f.selector, why: "the control is no longer on the page" });
      continue;
    }
    if (shown[i] || failed.some((x) => x.selector === f.selector)) continue;
    if (f.kind === "checkbox" && !/^(true|yes|1|on|checked)$/i.test(f.value)) continue;
    const why = f.kind === "combobox" ? await fillDropdownByClicking(page, f.selector, f.value, hints) : TYPED_KINDS.has(f.kind) ? await typeInto(page, f.selector, f.value) : "the page did not keep the value";
    const after = (await shownValues(page, [f.selector]))[0];
    if (why || !after) failed.push({ selector: f.selector, why: why ?? "the page did not keep the value" });
  }
  return failed;
}

const TYPED_KINDS = new Set(["text", "email", "tel", "url", "number", "textarea"]);

type ControlState = "on" | "off" | "missing";
function controlStates(page: Page, selectors: string[]): Promise<ControlState[]> {
  return page.call<ControlState[]>("(selectors) => selectors.map((s) => window.__awj.state(s))", selectors);
}

function shownValues(page: Page, selectors: string[]): Promise<string[]> {
  return page.call<string[]>('(selectors) => selectors.map((s) => { try { return window.__awj.shown(s); } catch { return ""; } })', selectors);
}

/** Types into a field with real key input, for the rare control that ignores a value set from script. */
function typeInto(page: Page, selector: string, value: string): Promise<string | null> {
  return inFront(page, async () => {
    const p = await page.awj<Point>("point", selector);
    if (!p.ok) return "control not found";
    await page.click(p.x, p.y);
    // Keys go wherever the focus is, so no focus on this exact control means no typing.
    if (!(await page.awj<boolean>("hasFocus", selector))) return "could not focus the control";
    await page.evaluate("window.__awj.selectAll()");
    await page.type(value);
    await page.evaluate("window.__awj.blur()");
    return null;
  });
}

async function pageFor(jobId: string): Promise<Page> {
  const s = loadSession()[jobId];
  const targets = (await listTargets()) ?? [];
  const t = s ? targets.find((x) => x.id === s.targetId) : undefined;
  if (!t) throw new Error(`No open tab for job ${jobId}. Run fill first.`);
  const page = await Page.attach(t);
  await install(page);
  return page;
}

export async function fillJob(jev: JevClient, profile: Profile, job: Job): Promise<FillReport> {
  const started = Date.now();
  await ensureBrowser();
  const old = loadSession()[job.id];
  if (old) await closeTab(old.targetId);
  const target = await newTab("about:blank");
  const page = await Page.attach(target);
  const base = { jobId: job.id, company: job.company, title: job.title, ats: job.ats };
  const done = (partial: Omit<FillReport, "ready">): FillReport => saveReport({ ...partial, ready: isReady(partial) });
  try {
    let d = await openForm(page, job);
    trace(`${job.company}: form open ${Date.now() - started}ms, ${d.fields.length} fields`);
    // Read and written in one synchronous step, so jobs filled side by side do not overwrite each other.
    saveSession({ ...loadSession(), [job.id]: { targetId: target.id, url: d.url } });
    if (!isApplicationForm(d) && !d.hasPassword) {
      // Job boards answer bursts with an error page. One unhurried second try settles most of them.
      const first = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url);
      if (first.state === "error" || first.state === "other") {
        trace(`${job.company}: page looked like ${first.state}, retrying in ${BROWSER.retryAfterMs}ms`);
        await sleep(BROWSER.retryAfterMs);
        d = await openForm(page, job);
      }
    }
    if (d.hasPassword) {
      // A password box means a login or account page. Nothing is typed into it.
      return done({ ...base, url: d.url, state: "blocked", reason: "login or account required", fields: [], drafts: [], reviews: [], failed: [], missingRequired: [], seconds: (Date.now() - started) / 1000, jevCostUsd: 0 });
    }
    if (!isApplicationForm(d)) {
      const state = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url);
      return done({ ...base, url: d.url, state: "blocked", reason: `no form found, page looks like: ${state.state}`, fields: [], drafts: [], reviews: [], failed: [], missingRequired: [], seconds: (Date.now() - started) / 1000, jevCostUsd: 0 });
    }
    await readDropdownOptions(page, d.fields);
    trace(`${job.company}: options read ${Date.now() - started}ms`);
    const plan = await mapForm(jev, profile, job, d);
    trace(`${job.company}: mapped ${Date.now() - started}ms`);
    // The resume goes in first: some boards (Lever) read it and write what they find into the form,
    // and the profile's values have to be the ones that stay.
    const uploaded = new Set<string>();
    const uploadFailures: { selector: string; why: string }[] = [];
    for (const u of plan.uploads) {
      const why = (await uploadFile(page, u.selector, u.path)) ?? null;
      if (!why) uploaded.add(u.selector);
      else uploadFailures.push({ selector: u.selector, why });
      trace(`${job.company}: upload ${why ?? "ok"}`);
    }
    let failedRaw = await applyFills(page, plan.fills, profile);
    trace(`${job.company}: filled ${Date.now() - started}ms`);
    failedRaw = [...(await secondLook(page, jev, profile, job, d, plan, failedRaw)), ...uploadFailures];
    writeFileSync(planFile(job.id), JSON.stringify({ dump: d, plan }, null, 2));
    return done({ ...base, ...(await report(page, d, plan, failedRaw, uploaded)), seconds: (Date.now() - started) / 1000, jevCostUsd: plan.jevCostUsd });
  } finally {
    page.close();
  }
}

/** The options most like the wanted value, by shared word stems, so a list of hundreds fits in one JEV question. */
export function closestOptions(options: string[], wanted: string, limit: number): string[] {
  if (options.length <= limit) return options;
  const stems = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 5));
  const want = new Set(stems(wanted));
  const scored = options.map((o) => ({ o, score: stems(o).filter((w) => want.has(w)).length + (norm(o).includes(norm(wanted)) ? 2 : 0) }));
  const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.o.length - b.o.length);
  return (hits.length ? hits : scored).slice(0, limit).map((x) => x.o);
}

/** Every option a search-as-you-type list offers for the wanted value: its starting list plus a search per word stem. */
async function candidateOptions(page: Page, selector: string, wanted: string): Promise<string[]> {
  const found = new Set(await readOptions(page, selector));
  for (const word of norm(wanted).split(/[^a-z0-9]+/).filter((w) => w.length >= 4)) {
    const more = await page.awj<string[] | null>("reactLoad", selector, word.slice(0, 6)).catch(() => null);
    for (const o of more ?? []) found.add(o);
  }
  return [...found];
}

/**
 * Two retries before anything is handed to Claude.
 * A dropdown that refused the value JEV named gets its real options gathered, cut to the closest few, and JEV picks among those.
 * A search box whose starter suggestions held nothing for the candidate is asked again as a value to type.
 */
async function secondLook(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump, plan: FillPlan, failed: { selector: string; why: string }[]): Promise<{ selector: string; why: string }[]> {
  const again: DumpedField[] = [];
  for (const f of d.fields) {
    if (f.kind !== "combobox" && f.kind !== "select") continue;
    const planned = plan.fields.find((p) => p.selector === f.selector);
    if (!hasChoosableOptions(f) && failed.some((x) => x.selector === f.selector)) {
      const wanted = planned?.value ?? "";
      const pool = f.kind === "select" ? f.options : (await candidateOptions(page, f.selector, wanted)).map((o) => ({ value: o, label: o }));
      const keep = new Set(closestOptions(pool.map((o) => o.label), wanted, FORM.maxOptionsForJev));
      const options = pool.filter((o) => keep.has(o.label));
      if (options.length) again.push({ ...f, options });
    } else if (f.kind === "combobox" && hasChoosableOptions(f) && planned && planned.action !== "fill" && /no option fits|left unselected/.test(planned.note ?? "")) {
      again.push({ ...f, options: [] });
    }
  }
  if (!again.length) return failed;
  const second = await mapForm(jev, profile, job, { ...d, fields: again });
  const stillFailed = await applyFills(page, second.fills, profile);
  for (const p of second.fields) {
    const i = plan.fields.findIndex((x) => x.selector === p.selector);
    const first = plan.fields[i];
    // A second answer replaces the first only when it produced a value.
    if (first && (p.action === "fill" || first.action === "fill")) plan.fields[i] = { ...p, id: first.id, note: p.note ?? "settled on a second look" };
  }
  const settled = new Set(second.fills.map((f) => f.selector));
  plan.reviews = [...plan.reviews.filter((r) => !settled.has(r.selector)), ...second.reviews.filter((r) => !plan.reviews.some((x) => x.selector === r.selector))];
  plan.jevCostUsd += second.jevCostUsd;
  trace(`${job.company}: second look at ${again.length} dropdown(s), ${second.fills.length - stillFailed.length} settled`);
  // A dropdown the second look could not settle either goes to Claude with its closest options attached.
  for (const f of again) {
    if (settled.has(f.selector) && !stillFailed.some((x) => x.selector === f.selector)) continue;
    if (!plan.reviews.some((r) => r.selector === f.selector)) plan.reviews.push({ id: f.id, selector: f.selector, kind: f.kind, label: f.label, options: f.options.map((o) => o.label), why: "no option matched the profile value" });
  }
  return [...failed.filter((f) => !settled.has(f.selector)), ...stillFailed];
}

/** Attaches a file and waits until the form's server has it. A refused upload (a rate limit) gets one unhurried second try. Returns why it failed, or undefined. */
async function uploadFile(page: Page, selector: string, file: string): Promise<string | undefined> {
  let why: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(BROWSER.retryAfterMs * 2);
    page.takeWrites();
    if (!(await page.setFiles(selector, attempt ? [] : [file]))) return "file input not found";
    if (attempt) await page.setFiles(selector, [file]);
    if (!(await waitForFile(page, path.basename(file)))) {
      why = "the page did not show the uploaded file";
      continue;
    }
    // The file travels to the form's server in the background; the application only has it once that finishes.
    await sleep(BROWSER.pollMs * 2);
    const settled = await page.writesSettled(BROWSER.uploadMs);
    const refused = page.takeWrites().failed;
    if (settled && !refused.length) return undefined;
    why = settled ? `the upload was refused: ${refused[0]}` : "the upload did not finish";
  }
  return why;
}

async function waitForFile(page: Page, name: string): Promise<boolean> {
  const deadline = Date.now() + BROWSER.optionsMs * 2;
  while (Date.now() < deadline) {
    if (await page.awj<boolean>("showsFile", name)) return true;
    await sleep(BROWSER.pollMs);
  }
  return false;
}

async function report(page: Page, d: FieldsDump, plan: FillPlan, failedRaw: { selector: string; why: string }[], uploaded = new Set<string>()): Promise<Pick<FillReport, "url" | "state" | "reason" | "fields" | "drafts" | "reviews" | "failed" | "missingRequired">> {
  const shown = await shownValues(page, plan.fields.map((f) => f.selector));
  const fields = plan.fields.map((f, i) => ({ label: f.label, required: f.required, action: f.action, shown: uploaded.has(f.selector) ? path.basename(f.value ?? "") : shown[i] ?? "", note: f.note }));
  const labelOf = (selector: string) => plan.fields.find((f) => f.selector === selector)?.label ?? selector;
  // The last line of defence: a value the plan wanted that the page does not show is a failure, whatever happened on the way.
  const states = await controlStates(page, plan.fields.map((f) => f.selector));
  const failed = [...failedRaw];
  plan.fields.forEach((f, i) => {
    if ((f.action === "fill" || f.action === "upload") && !fields[i]?.shown && states[i] !== "off" && !failed.some((x) => x.selector === f.selector)) {
      failed.push({ selector: f.selector, why: states[i] === "missing" ? "the control is no longer on the page" : "the value is not confirmed on the page" });
    }
  });
  return {
    url: plan.url,
    state: "filled",
    reason: null,
    fields,
    drafts: plan.drafts,
    reviews: plan.reviews,
    failed: failed.map((f) => ({ ...f, label: labelOf(f.selector) })),
    missingRequired: emptyRequired(d, plan, fields.map((f) => f.shown), states),
  };
}

/**
 * Hands every field still open on a filled form to Claude, writes its answers into the page,
 * reads them back, and records whether the form is now ready to submit.
 */
export async function resolveJob(profile: Profile, entry: QueueEntry | null, jobId: string): Promise<FillReport> {
  const r = loadReport(jobId);
  if (r.state !== "filled" || r.ready) return r;
  const { dump: d, plan } = JSON.parse(readFileSync(planFile(jobId), "utf8")) as { dump: FieldsDump; plan: FillPlan };
  const page = await pageFor(jobId);
  try {
    const dumped = (selector: string) => d.fields.find((f) => f.selector === selector);
    const open = new Map<string, OpenField>();
    const add = (selector: string, why: string) => {
      const f = dumped(selector);
      if (f && !open.has(selector)) open.set(selector, { selector, kind: f.kind, label: f.label, hint: f.hint || f.placeholder, required: f.required, maxLength: f.maxLength, options: f.options.map((o) => o.label), why });
    };
    for (const x of plan.drafts) add(x.selector, `needs writing (${x.intent})`);
    for (const x of plan.reviews) {
      add(x.selector, x.why);
      // A review can carry options gathered after the dump, on the second look.
      const o = open.get(x.selector);
      if (o && !o.options.length && x.options.length) o.options = x.options;
    }
    // A file that did not upload is not something Claude can answer; it stays a failure.
    for (const x of r.failed) if (dumped(x.selector)?.kind !== "file") add(x.selector, x.why);
    const before = await shownValues(page, plan.fields.map((f) => f.selector));
    const statesBefore = await controlStates(page, plan.fields.map((f) => f.selector));
    const stillEmpty = new Set(emptyRequired(d, plan, before, statesBefore));
    for (const f of plan.fields) if (stillEmpty.has(f.label)) add(f.selector, "required and still empty");
    const filled = plan.fields.map((f, i) => ({ label: f.label, value: before[i] ?? "" })).filter((f) => f.value && f.label);
    const resolution = await resolveOpenFields(profile, entry, filled, [...open.values()]);
    const fills = resolution.answers
      .map((a) => ({ selector: a.selector, kind: open.get(a.selector)?.kind ?? "text", value: a.value }))
      .filter((f) => !(f.kind === "checkbox" && !/^(true|yes|1|on|checked)$/i.test(f.value)));
    const failedRaw = [...(await applyFills(page, fills, profile)), ...r.failed.filter((x) => dumped(x.selector)?.kind === "file").map(({ selector, why }) => ({ selector, why }))];
    const after = await shownValues(page, plan.fields.map((f) => f.selector));
    const states = await controlStates(page, plan.fields.map((f) => f.selector));
    const answered = new Set(resolution.answers.map((a) => a.selector));
    const labelOf = (selector: string) => plan.fields.find((f) => f.selector === selector)?.label ?? selector;
    const fields = plan.fields.map((f, i) => {
      const was = r.fields[i];
      const shown = was?.action === "upload" && was.shown ? was.shown : after[i] ?? "";
      return { label: f.label, required: f.required, action: answered.has(f.selector) ? "claude" : f.action, shown, note: f.note };
    });
    const next: Omit<FillReport, "ready"> = {
      ...r,
      fields,
      drafts: plan.drafts.filter((x) => !after[plan.fields.findIndex((f) => f.selector === x.selector)]),
      // An open field Claude chose to leave blank is settled, unless it is required.
      reviews: plan.reviews.filter((x) => {
        const i = plan.fields.findIndex((f) => f.selector === x.selector);
        return !after[i] && (plan.fields[i]?.required ?? false) && states[i] !== "off";
      }),
      failed: [
        ...failedRaw,
        // Anything the plan or Claude wanted in the form that the page does not show.
        ...plan.fields.filter((f, i) => (f.action === "fill" || f.action === "upload" || fills.some((x) => x.selector === f.selector)) && !fields[i]?.shown && states[i] !== "off" && !failedRaw.some((x) => x.selector === f.selector)).map((f) => ({ selector: f.selector, why: "the value is not confirmed on the page" })),
      ].map((f) => ({ ...f, label: labelOf(f.selector) })),
      missingRequired: emptyRequired(d, plan, fields.map((f) => f.shown), states),
      resolution,
    };
    return saveReport({ ...next, ready: resolution.verdict === "ready" && isReady(next) });
  } finally {
    page.close();
  }
}

/** Writes extra values (Claude's drafts and review decisions) into a form that fill already opened. */
export async function setValues(profile: Profile, jobId: string, fills: Fill[]): Promise<{ failed: { selector: string; why: string }[]; shown: Record<string, string> }> {
  const page = await pageFor(jobId);
  try {
    const failed = await applyFills(page, fills, profile);
    const values = await shownValues(page, fills.map((f) => f.selector));
    return { failed, shown: Object.fromEntries(fills.map((f, i) => [f.selector, values[i] ?? ""])) };
  } finally {
    page.close();
  }
}

/** Reads the current state of an already-filled form: every planned field with what the page shows now. */
export async function inspect(jobId: string): Promise<{ fields: FieldReport[]; errors: string[] }> {
  const page = await pageFor(jobId);
  try {
    const { dump: d, plan } = JSON.parse(readFileSync(planFile(jobId), "utf8")) as { dump: FieldsDump; plan: FillPlan };
    const r = await report(page, d, plan, []);
    return { fields: r.fields, errors: await page.evaluate<string[]>("window.__awj.errors()") };
  } finally {
    page.close();
  }
}

/** Clicks the form's Submit control and reports what the page became. */
export async function submitJob(jev: JevClient, jobId: string, force = false): Promise<{ state: PageState["state"]; confidence: number; url: string; errors: string[]; excerpt: string }> {
  const r = loadReport(jobId);
  if (!r.ready && !force) throw new Error(`not ready to submit: ${r.resolution?.reason || [...r.missingRequired.map((l) => `empty: ${l.slice(0, 50)}`), ...r.failed.map((f) => `failed: ${f.label.slice(0, 50)}`), ...r.reviews.map((x) => `review: ${x.label.slice(0, 50)}`), ...r.drafts.map((x) => `draft: ${x.label.slice(0, 50)}`)].join("; ") || r.reason}`);
  const page = await pageFor(jobId);
  try {
    const { dump: d, plan } = JSON.parse(readFileSync(planFile(jobId), "utf8")) as { dump: FieldsDump; plan: FillPlan };
    const candidates = plan.submitSelectors.map((s) => ({ selector: s.split("  /*")[0] ?? s, text: /\/\*\s*(.*?)\s*\*\//.exec(s)?.[1] ?? "" }));
    const pick = candidates.find((c) => /submit/i.test(c.text)) ?? candidates.find((c) => /apply|send|finish/i.test(c.text) && !/linkedin|indeed/i.test(c.text));
    if (!pick) throw new Error("No submit control in the plan.");
    if (!force) {
      // The report says ready, but the page is what gets submitted: read the required fields once more.
      const selectors = plan.fields.map((f) => f.selector);
      const empty = emptyRequired(d, plan, await shownValues(page, selectors), await controlStates(page, selectors)).map((l) => l.slice(0, 50));
      if (empty.length) throw new Error(`not ready to submit, required fields are empty on the page: ${empty.join("; ")}`);
    }
    await page.bringToFront();
    await page.writesSettled(BROWSER.saveMs);
    const before = await page.evaluate<string>("window.__awj.pageText()");
    const p = await page.awj<Point>("point", pick.selector);
    if (!p.ok) throw new Error(`Submit control ${pick.selector} is not on the page.`);
    await page.click(p.x, p.y);
    const deadline = Date.now() + BROWSER.submitMs;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(BROWSER.pollMs * 3);
      try {
        await install(page);
        after = await page.evaluate<string>("window.__awj.pageText()");
      } catch {
        continue; // mid-navigation
      }
      if (after !== before && after.length > 0) break;
    }
    await sleep(BROWSER.pollMs * 6);
    await install(page);
    after = await page.evaluate<string>("window.__awj.pageText()");
    const url = await page.evaluate<string>("location.href");
    const state = await decidePageState(jev, after, url);
    return { state: state.state, confidence: state.confidence, url, errors: await page.evaluate<string[]>("window.__awj.errors()"), excerpt: after.replace(/\s+/g, " ").slice(0, 400) };
  } finally {
    page.close();
  }
}

export async function closeJobTab(jobId: string): Promise<void> {
  const session = loadSession();
  const s = session[jobId];
  if (s) await closeTab(s.targetId);
  delete session[jobId];
  saveSession(session);
}
