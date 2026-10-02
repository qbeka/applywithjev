/**
 * Everything Claude needs to write one free-text answer: the voice rules,
 * the facts it may use, the job, and the closest bank drafts.
 */
import { existsSync, readFileSync } from "node:fs";
import { PATHS, WRITER } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import { BANK_DRAFTS, BANK_INTENTS, closestIntents, type BankIntent } from "./bank.js";

/** The posting as the writer sees it. */
export function jobContext(entry: QueueEntry | null) {
  return entry
    ? {
        company: entry.job.company,
        title: entry.job.title,
        locations: entry.job.locations,
        url: entry.job.url,
        description: (entry.job.description ?? "").slice(0, WRITER.maxDescriptionChars),
        fitReasons: entry.fit?.reasons ?? [],
      }
    : null;
}

export function answerContext(profile: Profile, entry: QueueEntry | null, question: string) {
  const voice = existsSync(PATHS.voice) ? readFileSync(PATHS.voice, "utf8") : "";
  const intents = question ? closestIntents(question) : [];
  return {
    voice,
    question,
    closestDrafts: intents.map((i) => ({ intent: i, description: BANK_INTENTS[i], draft: BANK_DRAFTS[i] })),
    allIntents: Object.keys(BANK_INTENTS),
    job: jobContext(entry),
    candidate: {
      name: `${profile.name.first} ${profile.name.last}`,
      summary: profile.summary,
      facts: profile.facts,
      standingAnswers: profile.answers,
      experience: profile.experience,
      projects: profile.projects,
      skills: profile.skills,
      links: profile.links,
      workAuthorization: profile.workAuthorization.statement,
      availability: profile.preferences.availability,
      earliestStart: profile.preferences.earliestStart,
    },
    rules: [
      "Use only the facts above and the job description.",
      "No em dashes, no exclamation marks, no hype words.",
      "Match the field's length. Respect maxLength.",
      "Write it so it reads as typed by the candidate, not generated.",
    ],
  };
}

export function draftFor(intent: string): string | null {
  return intent in BANK_DRAFTS ? (BANK_DRAFTS[intent as BankIntent] ?? null) : null;
}
