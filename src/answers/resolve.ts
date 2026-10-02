/**
 * What JEV leaves open goes to Claude: questions that need writing, fields it
 * was unsure of, and values the page refused. Claude Code runs headless with
 * no tools, reads the candidate's facts and the open fields, and returns one
 * JSON object. It may also say the job should not be applied to, with a reason.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import { WRITER } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import { BANK_DRAFTS, BANK_INTENTS } from "./bank.js";
import { answerContext } from "./context.js";

export type OpenField = {
  selector: string;
  kind: string;
  label: string;
  hint: string;
  required: boolean;
  maxLength: number | null;
  options: string[];
  /** Why it is open: a draft, a review, or the reason a value did not land. */
  why: string;
};

export const Resolution = z.object({
  /** ready: every open field is answered or rightly left blank. needs_review: a required field cannot be answered truthfully. skip: the job should not be applied to. */
  verdict: z.enum(["ready", "needs_review", "skip"]),
  reason: z.string().default(""),
  answers: z.array(z.object({ selector: z.string(), value: z.string() })).default([]),
});
export type Resolution = z.infer<typeof Resolution>;

const SYSTEM = [
  "You finish job application forms for one candidate. You are given the candidate's facts, the job, what is already filled in, and the fields still open.",
  "Reply with one JSON object and nothing else: {\"verdict\": \"ready\" | \"needs_review\" | \"skip\", \"reason\": string, \"answers\": [{\"selector\": string, \"value\": string}]}.",
  "",
  "Truth comes first.",
  "- Use only the candidate's facts, experience, projects, standing answers and the job posting. Never invent a fact, a number, a skill level, a date or a credential.",
  "- Work authorization, citizenship, education and dates are exactly as given. The candidate is authorized only in the countries listed and needs sponsorship elsewhere.",
  "- If a required field cannot be answered truthfully from the facts (a residence the candidate does not have, a self-rating of a skill the facts do not mention, a quiz or take-home, a clearance, a reference's contact details), do not guess: set verdict to \"needs_review\" and say which field in reason.",
  "- needs_review is only for that. When the facts or a standing answer reasonably settle a field, answer it and keep the verdict \"ready\". A person who is not employed has no notice period, so the shortest option is true.",
  "- If the form requires a cover letter or references, set verdict to \"skip\" with the reason.",
  "- Whether to apply is the candidate's decision, already made. A posting that prefers another graduation date, location or visa status is not a reason to stop: answer every question truthfully, follow the standing answers, and note the mismatch in reason while keeping the verdict \"ready\".",
  "",
  "How to answer each kind of field.",
  "- select, radio, combobox with options: value is one option copied exactly. With no options listed for a combobox, value is the text to search for.",
  "- checkbox: \"true\" or \"false\". Consent that is needed to submit the application is \"true\". Optional marketing, job alerts, text messages and keeping data for future roles are \"false\".",
  "- text and textarea: write in the candidate's voice, following the voice rules exactly, inside maxLength. Match the length to the question: one line for a one-line box, 60 to 140 words for an open question unless it asks for more or less.",
  "- A group of checkboxes where none applies: tick \"None of the above\" only if the facts settle every item in the group, otherwise tick \"I prefer not to answer\" when that exists.",
  "- Salary: use the standing wording unless a number is forced, which is needs_review.",
  "- Answer what is asked and no more. Sponsorship, visa status, GPA and anything else that counts against the candidate are stated truthfully wherever a field asks for them, and are not volunteered in free text that did not ask.",
  "- An optional field gets a value whenever the facts give a true one. Leave it out of answers only when nothing true applies to it.",
  "- A field listed with a reason like \"the page did not keep the value\" needs the value in the format the field wants (for a date box, a real date such as 2027-05-03 or 05/03/2027 as the hint or placeholder shows).",
  "",
  "Answer every open field you can, even when the verdict is needs_review, so a person only has to finish what is left.",
].join("\n");

export function buildPrompt(profile: Profile, entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): string {
  const ctx = answerContext(profile, entry, "");
  return JSON.stringify(
    {
      voice_rules: ctx.voice,
      candidate: {
        ...ctx.candidate,
        education: profile.education,
        address: `${profile.address.city}, ${profile.address.region}, ${profile.address.country}`,
        spokenLanguages: profile.spokenLanguages,
        demographics: profile.demographics,
        preferences: profile.preferences,
        workAuthorization: profile.workAuthorization,
      },
      /** Starting drafts for common questions. Adapt one to the question and the company; text in braces is for you to write. */
      bank: Object.fromEntries(Object.keys(BANK_INTENTS).map((k) => [k, { asks: BANK_INTENTS[k], draft: BANK_DRAFTS[k] }])),
      job: ctx.job ? { ...ctx.job, description: ctx.job.description.slice(0, WRITER.maxDescriptionChars) } : null,
      already_filled: filled,
      open_fields: open,
    },
    null,
    1,
  );
}

/** Pulls the JSON object out of the writer's reply, whether or not it wrapped it in a code fence. */
export function parseResolution(text: string): Resolution {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the writer did not return JSON");
  return Resolution.parse(JSON.parse(text.slice(start, end + 1)));
}

const LOG_SYSTEM = [
  "You write two short cells for a job-application tracking sheet. Reply with one JSON object and nothing else:",
  "{\"what_they_do\": string, \"why_fit\": string}.",
  "what_they_do: one plain sentence on what the company builds, from the posting. If the posting says nothing about it, leave it empty.",
  "why_fit: one plain sentence tying a concrete fact about the candidate to this role, written as the candidate's own note: start with the fact, and never write \"the candidate\", \"he\" or \"she\".",
  "Use only the posting and the candidate's facts. No em dashes, no hype words, under 30 words each.",
].join("\n");

const LogLines = z.object({ what_they_do: z.string().default(""), why_fit: z.string().default("") });

/** The sheet's "What They Do" and "Why You're a Fit" cells for a job that was just applied to. Empty strings if the writer fails: the log must not block on it. */
export async function logLines(profile: Profile, entry: QueueEntry): Promise<{ whatTheyDo: string; whyFit: string }> {
  try {
    const ctx = answerContext(profile, entry, "");
    const text = await runWriter(JSON.stringify({ job: ctx.job ? { ...ctx.job, description: ctx.job.description.slice(0, WRITER.maxDescriptionChars) } : null, candidate: { summary: profile.summary, facts: profile.facts } }), LOG_SYSTEM);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = LogLines.parse(JSON.parse(text.slice(start, end + 1)));
    return { whatTheyDo: parsed.what_they_do, whyFit: parsed.why_fit };
  } catch {
    return { whatTheyDo: "", whyFit: "" };
  }
}

function runWriter(prompt: string, system = SYSTEM): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      WRITER.command,
      ["-p", "--model", WRITER.model, "--effort", WRITER.effort, "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--system-prompt", system],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the writer did not answer in ${WRITER.timeoutMs / 1000}s`));
    }, WRITER.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${WRITER.command}: ${e.message}. Claude Code must be installed and logged in.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`the writer exited with ${code}: ${err.slice(0, 300)}`));
      try {
        const envelope = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (envelope.is_error || typeof envelope.result !== "string") return reject(new Error(`the writer failed: ${String(envelope.result).slice(0, 300)}`));
        resolve(envelope.result);
      } catch {
        reject(new Error("the writer's output was not JSON"));
      }
    });
    child.stdin.end(prompt);
  });
}

export async function resolveOpenFields(profile: Profile, entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): Promise<Resolution> {
  if (!open.length) return { verdict: "ready", reason: "", answers: [] };
  const res = parseResolution(await runWriter(buildPrompt(profile, entry, filled, open)));
  const known = new Set(open.map((f) => f.selector));
  return { ...res, answers: res.answers.filter((a) => known.has(a.selector)) };
}
