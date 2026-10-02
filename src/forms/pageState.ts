/**
 * One JEV call that tells the apply loop what it is looking at after a
 * navigation or a click. Keeps Claude from reading whole pages itself.
 */
import { JEV } from "../config.js";
import type { JevClient } from "../jev/client.js";
import { choice, noul } from "../jev/questions.js";
import type { ChoiceAnswer, NoulAnswer } from "../jev/types.js";
import { truncate } from "../util/text.js";

export type PageState = {
  state: "job_description" | "application_form" | "submitted" | "login_required" | "captcha" | "closed" | "error" | "other";
  confidence: number;
  probabilities: Record<string, number>;
  hasApplyButton: number;
  hasMorePages: number;
  requiresReferences: number;
  requiresCoverLetter: number;
};

export async function decidePageState(jev: JevClient, pageText: string, url: string, jobId = ""): Promise<PageState> {
  const answers = await jev.decide(
    { url, text: truncate(pageText.replace(/\s+/g, " "), JEV.maxPageTextChars) },
    {
      state: choice("What kind of page is this?", {
        job_description: "A job posting with a description and an Apply button or link, but no form fields yet",
        application_form: "An application form with input fields to fill (name, email, resume, questions)",
        submitted: "A confirmation that the application was received or submitted, a thank-you page",
        login_required: "A sign-in, create-account or password page that blocks the application",
        captcha: "A CAPTCHA, bot check, or 'verify you are human' challenge",
        closed: "The posting is closed, expired, no longer accepting applications, or not found",
        error: "An error page: validation errors shown on the form, a 404 or 500, or a blank page",
        other: "None of the above",
      }),
      has_apply_button: noul("Is there an Apply, Apply now, or Start application button or link?"),
      has_more_pages: noul("Does the form continue on another page (a Next, Continue or Save and continue button rather than Submit)?"),
      requires_references: noul("Does the form require references (names and contact details of referees)?"),
      requires_cover_letter: noul("Is a cover letter required (not optional)?"),
    },
    jobId ? `page-state:${jobId}` : "page-state",
  );
  const s = answers.state as ChoiceAnswer;
  return {
    state: s.choice as PageState["state"],
    confidence: s.confidence,
    probabilities: s.probabilities,
    hasApplyButton: (answers.has_apply_button as NoulAnswer).noul,
    hasMorePages: (answers.has_more_pages as NoulAnswer).noul,
    requiresReferences: (answers.requires_references as NoulAnswer).noul,
    requiresCoverLetter: (answers.requires_cover_letter as NoulAnswer).noul,
  };
}
