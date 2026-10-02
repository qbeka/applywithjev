/**
 * What employers wrote back. `inbox` reads the headers of recent mail, keeps
 * the messages that belong to a job that was applied to, and records what
 * each one says: received, rejected, an interview, a test, an offer, a
 * question. Mail is only read. Nothing is marked, moved, answered or deleted.
 *
 * One kind of message is handled by rule and never opened: a board's emailed
 * code that confirms a person is applying. The tool notes that it arrived and
 * for which job. The code itself is for the person to read and type.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MAIL, PATHS } from "../config.js";
import type { JevClient } from "../jev/client.js";
import { choice } from "../jev/questions.js";
import type { ChoiceAnswer } from "../jev/types.js";
import { hostIs } from "../jobs/normalize.js";
import type { MailHeader } from "./imap.js";

export const REPLY_KINDS = ["received", "rejected", "interview", "assessment", "offer", "question", "unrelated"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
export type MailKind = ReplyKind | "code";

/** A job the mail may be about. */
export type AppliedJob = { id: string; company: string; title: string; appliedAt: string | null };

const Seen = z.object({
  jobId: z.string(),
  kind: z.enum([...REPLY_KINDS, "code"]),
  at: z.string(),
  from: z.string(),
  /** Kept for replies so the person can find the message. Not kept for a code message. */
  subject: z.string().default(""),
});
export type Seen = z.infer<typeof Seen>;
export const InboxFile = z.object({ version: z.literal(1).default(1), seen: z.record(Seen).default({}) });
export type InboxFile = z.infer<typeof InboxFile>;

export function loadInbox(file = PATHS.inbox): InboxFile {
  if (!existsSync(file)) return InboxFile.parse({});
  try {
    return InboxFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return InboxFile.parse({});
  }
}

export function saveInbox(inbox: InboxFile, file = PATHS.inbox): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(inbox, null, 1));
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|group|technologies|technology|labs|studios|solutions|the)\b/g;
/** The words that name a company: "Slice (slicelife.com)" is slice, "Haven Studios" is haven. */
export function companyWords(company: string): string[] {
  const base = norm(company.replace(/\([^)]*\)/g, " "));
  const words = base.replace(SUFFIX, " ").split(" ").filter(Boolean);
  return words.length ? words : base.split(" ").filter(Boolean);
}

/** Subjects that speak of an application. Used only to decide which mail is worth showing JEV, which makes the judgement. */
const ABOUT_AN_APPLICATION = /\b(appl(y|ying|ied|ication)|candidat\w*|interview|assessment|position|opportunity|recruit\w*)\b/i;

/** A board's message that carries a code to confirm a person is applying. Told by its subject alone. */
export const isCodeMessage = (subject: string) => /\b(security|verification|confirmation) code\b/i.test(subject);

/**
 * Which applied job a message is about, or null. The company's name must be in the subject or
 * the sender's name as whole words, and the sender must be that company or a mail system that
 * sends for employers. Among several jobs at one company, the one whose title the subject shares
 * most words with wins, then the one applied to last.
 */
export function matchJob(m: Pick<MailHeader, "from" | "subject" | "date">, jobs: AppliedJob[]): AppliedJob | null {
  const subject = ` ${norm(m.subject)} `;
  const sender = ` ${norm(m.from.name)} `;
  const fromAts = MAIL.atsSenders.some((d) => hostIs(m.from.domain, d));
  const domainWords = norm(m.from.domain.split(".").slice(0, -1).join(" "));
  const hits = jobs.filter((j) => {
    const words = companyWords(j.company);
    if (!words.length) return false;
    const phrase = ` ${words.join(" ")} `;
    const named = subject.includes(phrase) || sender.includes(phrase);
    const fromCompany = words.every((w) => domainWords.replace(/ /g, "").includes(w));
    // Mail that arrived before the application cannot be an answer to it.
    const after = !j.appliedAt || !m.date || new Date(m.date).getTime() >= new Date(j.appliedAt).getTime() - 3_600_000;
    return named && (fromAts || fromCompany || sender.includes(phrase) || ABOUT_AN_APPLICATION.test(m.subject)) && after;
  });
  if (hits.length <= 1) return hits[0] ?? null;
  const shared = (j: AppliedJob) => norm(j.title).split(" ").filter((w) => w.length > 2 && subject.includes(` ${w} `)).length;
  return [...hits].sort((a, b) => shared(b) - shared(a) || (b.appliedAt ?? "").localeCompare(a.appliedAt ?? ""))[0] ?? null;
}

/** The question JEV is asked about one message. Every outcome is a definition. */
export const replyQuestion = () =>
  choice("What does this email tell the candidate about their job application?", {
    received: "It only confirms that the application was received or is under review. No decision and nothing to do.",
    rejected: "The employer will not move forward: a rejection, the role was filled or closed, or the candidate does not meet a requirement.",
    interview: "It invites the candidate to an interview, a call or a conversation with a person, or asks them to pick a time for one.",
    assessment: "It asks the candidate to complete a test: an online assessment, a coding challenge, a take-home task, a recorded video or a questionnaire.",
    offer: "It offers the candidate the job.",
    question: "It asks the candidate for something else before the application can go on: a missing document, a form to fill, a detail to confirm.",
    unrelated: "It is not about this application: marketing, a newsletter, a job alert, an account notice, or mail about another company or another person.",
  });

/** Asks JEV what one message says. Only the text of a message already matched to an applied job is sent. */
export async function classifyReply(jev: JevClient, job: AppliedJob, m: Pick<MailHeader, "from" | "subject">, text: string): Promise<{ kind: ReplyKind; confidence: number }> {
  const answers = await jev.decide(
    { application: { company: job.company, role: job.title }, email: { from: `${m.from.name} <${m.from.address}>`.trim(), subject: m.subject, text: text.slice(0, MAIL.maxBodyChars) } },
    { kind: replyQuestion() },
    `reply:${job.id}:${job.company}`,
  );
  const a = answers.kind as ChoiceAnswer;
  return { kind: (REPLY_KINDS as readonly string[]).includes(a.choice) ? (a.choice as ReplyKind) : "unrelated", confidence: a.confidence };
}

export const REPLY_LABEL: Record<ReplyKind, string> = { received: "Received", rejected: "Rejected", interview: "Interview", assessment: "Test to complete", offer: "Offer", question: "They need something", unrelated: "" };

/**
 * What the record shows for a job: its latest reply that says more than "received", or
 * "received" when that is all there is. Null when no mail about the job has been seen.
 */
export function latestReply(inbox: InboxFile, jobId: string): Seen | null {
  const mine = Object.values(inbox.seen).filter((s) => s.jobId === jobId && s.kind !== "code" && s.kind !== "unrelated").sort((a, b) => a.at.localeCompare(b.at));
  return [...mine].reverse().find((s) => s.kind !== "received") ?? mine[mine.length - 1] ?? null;
}

/** When the newest code message for a job arrived, at or after `since`. Null when none has. */
export function codeArrived(inbox: InboxFile, jobId: string, since = ""): Seen | null {
  return Object.values(inbox.seen).filter((s) => s.jobId === jobId && s.kind === "code" && s.at >= since).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

export type Sorted = { news: { job: AppliedJob; seen: Seen }[]; inbox: InboxFile };

/**
 * Goes through message headers, newest last, and judges each one that is new and belongs to an
 * applied job. `read` fetches a message's text, and is not called for a code message.
 */
export async function sortMail(headers: MailHeader[], jobs: AppliedJob[], inbox: InboxFile, read: (uid: number) => Promise<string>, jev: JevClient): Promise<Sorted> {
  const news: Sorted["news"] = [];
  for (const m of [...headers].sort((a, b) => a.date.localeCompare(b.date))) {
    if (inbox.seen[m.messageId]) continue;
    const job = matchJob(m, jobs);
    if (!job) continue;
    const from = m.from.name || m.from.address;
    let seen: Seen;
    if (isCodeMessage(m.subject)) {
      seen = { jobId: job.id, kind: "code", at: m.date, from, subject: "" };
    } else {
      const { kind } = await classifyReply(jev, job, m, await read(m.uid));
      seen = { jobId: job.id, kind, at: m.date, from, subject: m.subject };
    }
    inbox.seen[m.messageId] = seen;
    if (seen.kind !== "unrelated") news.push({ job, seen });
  }
  return { news, inbox };
}
