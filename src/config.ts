/**
 * Single source of every tunable: paths, thresholds, weights, limits.
 * Nothing else in the codebase hardcodes a number that changes behaviour.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, "data"),
  profile: path.join(ROOT, "data", "profile.json"),
  profileExample: path.join(ROOT, "data", "profile.example.json"),
  /** The style guide for written answers. data/voice.local.md, when present, is the candidate's own and wins over the shipped one. */
  voice: existsSync(path.join(ROOT, "data", "voice.local.md")) ? path.join(ROOT, "data", "voice.local.md") : path.join(ROOT, "data", "voice.md"),
  bank: path.join(ROOT, "data", "bank.json"),
  bankExample: path.join(ROOT, "data", "bank.example.json"),
  queue: path.join(ROOT, "data", "queue.json"),
  /** Every job the tool considered, with what happened to it. */
  applications: path.join(ROOT, "data", "applications.csv"),
  /** Only the applications that were sent, newest first. It sits at the top of the folder so it is easy to find. */
  applied: path.join(ROOT, "applied.csv"),
  /** Answers the writer has given before, kept so the same question is not paid for twice. */
  memory: path.join(ROOT, "data", "memory.json"),
  cache: path.join(ROOT, "data", "cache"),
  walledHosts: path.join(ROOT, "data", "cache", "walled-hosts.json"),
  /** Sites the person has signed in to, in the runner's Chrome profile. */
  sites: path.join(ROOT, "data", "sites.json"),
  /** Mail already read and what it was, so each message is judged once. */
  inbox: path.join(ROOT, "data", "inbox.json"),
  runs: path.join(ROOT, "data", "runs"),
  jevUsage: path.join(ROOT, "data", "runs", "jev-usage.jsonl"),
  writerUsage: path.join(ROOT, "data", "runs", "writer-usage.jsonl"),
  imports: path.join(ROOT, "data", "imports"),
  resumeDir: path.join(ROOT, "data", "resume"),
  browserScripts: path.join(ROOT, "src", "forms"),
} as const;

/** Loads KEY=value lines from .env into process.env without overriding existing values. */
export function loadEnv(file = path.join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const JEV = {
  endpoint: "https://openrouter.ai/api/alpha/decisions",
  model: "typesafe/jev-1.13",
  /** Context window per the model page. We keep requests well under it. */
  contextTokens: 32_000,
  /** Approximate budget for the job description inside a rating request (chars, ~4 chars per token). */
  maxDescriptionChars: 14_000,
  /** Approximate budget for a page's text when deciding page state. */
  maxPageTextChars: 8_000,
  timeoutMs: 20_000,
  maxRetries: 3,
  retryBaseMs: 500,
  /** Hard stop for one discover run, in USD. The model page lists $0.042 per million input tokens. */
  runSpendCapUsd: 1.0,
} as const;

export const DISCOVER = {
  /** Only postings this fresh are considered. */
  maxAgeDays: 14,
  /** Concurrency for description fetches. */
  fetchConcurrency: 8,
  /** Concurrency for JEV rating calls. */
  rateConcurrency: 6,
  /** Fetch timeout for job pages and ATS APIs. */
  fetchTimeoutMs: 15_000,
  /** How many jobs to surface in the queue per run. */
  queueSize: 150,
  /**
   * Minimum composite score to be queued. Hard rules (work authorization,
   * degree, pay, level) are skips, not scores, so this only trims the long
   * tail of weak matches. The queue is ranked, so the best apply first.
   */
  applyThreshold: 0.3,
  /**
   * Careers sites known to need an account or a login before the form, by hostname fragment.
   * Jobs there are skipped before rating. Sites the apply run finds walled are remembered in
   * data/cache/walled-hosts.json and skipped the same way next time.
   */
  accountWalledHosts: ["eightfold.ai", "careers.microsoft.com", "jobs.intuit.com", "jobs.ea.com"],
  /** Job boards whose forms run over several pages, which the fill runner does not walk yet. Their jobs are skipped with that reason. */
  multiStepAts: ["jobvite", "smartrecruiters"],
  /** Sources that are read from GitHub. Each entry names the raw file and its parser. */
  sources: {
    simplifyInternships:
      "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    simplifyNewGrad:
      "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    canadianInternships2027:
      "https://raw.githubusercontent.com/negarprh/Canadian-Tech-Internships-2027/main/README.md",
    vanshSummer2027:
      "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md",
    canadaSummer2027:
      "https://raw.githubusercontent.com/michelleokolie/canada-tech-internships-summer-2027/main/README.md",
  },
} as const;

/**
 * Composite fit score. Every component is 0..1 before weighting.
 * Weights sum to 1; location and recency are multipliers applied after.
 */
export const FIT_WEIGHTS = {
  stackMatch: 0.22,
  experienceMatch: 0.18,
  callbackLikelihood: 0.3,
  levelFit: 0.15,
  termFit: 0.1,
  interviewPractical: 0.05,
} as const;

export const LOCATION_MULTIPLIER = {
  vancouver: 1.0,
  canada: 0.92,
  remote: 0.9,
  us: 0.75,
  international: 0.6,
  unclear: 0.7,
} as const;

/** Applied when the posting asks for a graduation date the candidate does not have. They can still apply, so it ranks lower instead of being dropped. */
export const GRADUATION_MISMATCH_MULTIPLIER = 0.6;

/** Recency multiplier: 1.0 for today, decaying linearly to this floor at maxAgeDays. */
export const RECENCY_FLOOR = 0.7;

export const FORM = {
  /** JEV confidence at or above which a mapping is applied without note. */
  autoConfidence: 0.9,
  /** Below this, Claude decides the field by hand. */
  reviewConfidence: 0.5,
  /** Selects with more options than this are pre-filtered in code before JEV sees them. */
  maxOptionsForJev: 40,
  /** Fields per JEV call. Larger forms are split into several calls. */
  fieldsPerCall: 40,
} as const;

export const BROWSER = {
  /** The Chrome binary the fill runner drives over the DevTools protocol. */
  chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  /** Local DevTools port of the runner's own Chrome window. */
  port: 9333,
  /** Its profile lives with the other run data, so it is git-ignored and keeps cookies between runs. */
  profileDir: path.join(ROOT, "data", "runs", "chrome-profile"),
  /** Longest wait for a page to load and its form controls to stop changing. */
  settleMs: 15_000,
  /** How long a loaded page with no form controls is given before it is read as having no form. */
  emptyPageMs: 6_000,
  /** Longest wait for a dropdown's options to appear after a click or typing. */
  optionsMs: 4_000,
  /** A page that answered with an error is reopened once after this pause. */
  retryAfterMs: 8_000,
  /** Waits before a typed value the page did not keep is put back: once soon, once later. */
  putBackAfterMs: [1_500, 5_000],
  /** Longest wait for a form to finish saving one field to its own server before the next field is set. */
  saveMs: 3_000,
  /** Longest wait for an uploaded resume to reach the form's server. */
  uploadMs: 20_000,
  /** Longest wait for the page to change after Submit is clicked. */
  submitMs: 12_000,
  /** A page that still looks like the form after that, with no error on it, is given this much longer: some boards take their time to confirm. */
  confirmMs: 20_000,
  pollMs: 150,
} as const;

/**
 * The writer for what JEV cannot type: open questions, and fields it was unsure of.
 * It is Claude Code itself, run headless, so it uses the user's own login and no API key.
 */
export const WRITER = {
  command: "claude",
  model: "claude-sonnet-5-5",
  effort: "high",
  timeoutMs: 180_000,
  /** Job description characters handed to the writer. The posting is most of what each call costs. */
  maxDescriptionChars: 4_000,
  /** Posting characters per job when writing the two sheet notes, where the opening paragraph is enough. */
  maxNoteChars: 1_500,
  /**
   * Where the headless call runs. Claude Code adds the CLAUDE.md of the folder it starts in to every
   * prompt, and this project's CLAUDE.md is about changing the code, not about writing answers.
   * An empty folder outside the project keeps those 1,300 tokens out of every call.
   */
  cwd: path.join(os.tmpdir(), "applywithjev-writer"),
  /**
   * The candidate's context is cached by the provider. A run reads it again within seconds, so the
   * five-minute cache is enough, and writing to it costs 1.25 times the input price where the
   * one-hour cache costs 2 times.
   */
  env: { FORCE_PROMPT_CACHING_5M: "1" },
} as const;

/** The answer memory: what the writer already answered, reused instead of asked again. */
export const MEMORY = {
  enabled: true,
  /** JEV's confidence that a new question asks for the same thing as a remembered one, at or above which the remembered answer is used. */
  sameQuestionConfidence: 0.9,
  /** Remembered questions shown to JEV per open field, closest wording first. */
  candidates: 5,
  /** Share of the shorter question's words the two must have in common before JEV is asked at all. */
  minWordOverlap: 0.3,
} as const;

/** Signing in is done by the person, in the runner's window. The tool only watches for it to be over. */
export const SITES = {
  /** How long `connect` waits for the person to finish signing in. */
  connectTimeoutMs: 300_000,
  /** How often the page is looked at while waiting. */
  pollMs: 1_000,
  /** The sign-in counts as done when no password box has been on the page for this long after one was. */
  quietMs: 4_000,
} as const;

/** Mail is read, never changed: the mailbox is opened read-only. */
export const MAIL = {
  host: "imap.gmail.com",
  port: 993,
  /** How far back `inbox` reads when it is not told. */
  lookbackDays: 21,
  /** Characters of one message shown to JEV. */
  maxBodyChars: 4_000,
  /** Bytes of one message fetched: enough for the text part of a recruiting email. */
  maxFetchBytes: 60_000,
  timeoutMs: 30_000,
  /** Headers are fetched this many messages at a time. */
  fetchBatch: 200,
  /** Mail systems that send on behalf of employers. A message from one of them counts as from the company it names. */
  atsSenders: ["greenhouse-mail.io", "greenhouse.io", "ashbyhq.com", "lever.co", "myworkday.com", "smartrecruiters.com", "rippling.com", "workablemail.com", "workable.com", "bamboohr.com", "icims.com", "successfactors.com", "jobvite.com"],
} as const;

/** The mailbox to read, from .env. Null when the person has not set it up. */
export function mailCredentials(): { address: string; password: string } | null {
  const address = (process.env.GMAIL_ADDRESS ?? "").trim();
  const password = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  return address && password ? { address, password } : null;
}

/** What `doctor` checks against. */
export const DOCTOR = {
  minNodeMajor: 22,
  /** Most job boards refuse a larger resume. */
  maxResumeBytes: 5_000_000,
  /** A queue older than this is worth refreshing before a run: postings close. */
  staleQueueHours: 24,
  claudeTimeoutMs: 60_000,
} as const;

export const RUN = {
  /** Applications filled, then paused for human review, before the loop becomes autonomous. */
  reviewFirst: 3,
  /** Target applications per run. */
  targetPerRun: 50,
  /** Forms the runner fills side by side, one tab each. */
  fillConcurrency: 5,
  /** Of those, how many may be on the same site at once, and the pause between opening two forms there. Job boards throttle bursts. */
  perHostConcurrency: 2,
  /** Sites that save every field to their server as it changes, and rate-limit bursts: one form at a time, with a longer pause. */
  gentleHosts: ["ashbyhq.com"],
  gentleGapMs: 6_000,
  /** How long `codes` waits on one form for the person to type the code and send it. */
  codeWaitMs: 240_000,
  /** The pause between two submissions to the same site. A burst of applications from one person looks like a robot, and boards answer it with a human check. */
  submitGapMs: 20_000,
  /** How many times a form is opened and filled when values did not land. A page that loaded badly (a script of its own missing) is often fine on a second load. */
  fillAttempts: 2,
  /** Longest one form may take to open and fill. A page that never settles is recorded as blocked instead of holding up the run. */
  fillTimeoutMs: 180_000,
  /** Forms handed to the writer at once. */
  writerConcurrency: 3,
  hostGapMs: 2_500,
} as const;
