/**
 * Turns a dumped form into a fill plan with one JEV call per chunk of fields.
 *
 * Text-like fields: a choice over every profile key, bank intent and special
 * key, so the answer is "which value goes here" in one shot.
 * Select, radio and combobox fields: a choice over the field's own options
 * (plus "none") given the candidate's facts, so the answer is the option.
 * Checkboxes: a noul, "should this be checked".
 * File inputs: resume upload, no model needed.
 */
import { FORM } from "../config.js";
import type { JevClient } from "../jev/client.js";
import { choice, noul } from "../jev/questions.js";
import type { Answer, ChoiceAnswer, NoulAnswer, Questions } from "../jev/types.js";
import { ALL_KEYS, isProfileKey, isSpecialKey, profileFacts, valueFor, type FieldKey } from "../profile/fieldKeys.js";
import { monthName, type Profile } from "../profile/schema.js";
import { BANK_INTENTS } from "../answers/bank.js";
import { locationTier } from "../jobs/hardFilters.js";
import type { Job } from "../jobs/normalize.js";
import type { DumpedField, FieldsDump, FillPlan, PlannedField } from "./fields.js";

const NONE = "__none__";

export function buildFormState(profile: Profile, job: Job, dump: FieldsDump, fields: DumpedField[]): Record<string, unknown> {
  const tier = locationTier(job.locations);
  const country = tier === "vancouver" || tier === "canada" ? "Canada" : tier === "us" ? "United States" : tier === "remote" ? "remote (treat as the company's country)" : "unknown";
  return {
    page: { url: dump.url, title: dump.title, context: dump.context },
    job: { company: job.company, title: job.title, locations: job.locations, country },
    candidate: {
      facts: profileFacts(profile),
      work_authorization: {
        citizenships: profile.workAuthorization.citizenships,
        authorized_without_sponsorship_in: profile.workAuthorization.authorizedCountries,
        needs_sponsorship_elsewhere: profile.workAuthorization.requiresSponsorshipElsewhere,
        statement: profile.workAuthorization.statement,
        for_this_job: authForCountry(profile, country),
      },
      education: {
        ...profile.education[0],
        degree_start: `${monthName(profile.education[0]?.startMonth ?? 1)} ${profile.education[0]?.startYear} (month ${profile.education[0]?.startMonth})`,
        degree_end_or_graduation: `${monthName(profile.education[0]?.gradMonth ?? 1)} ${profile.education[0]?.gradYear} (month ${profile.education[0]?.gradMonth})`,
      },
      demographics: profile.demographics,
      preferences: profile.preferences,
      /** The candidate's own answers to recurring questions. They outrank any guess. */
      standing_answers: profile.answers,
      gpa_policy: "Only give a GPA if the field is required. The cumulative GPA is " + (profile.education[0]?.gpa?.cumulative ?? "not provided") + " on a 4.0 scale.",
      rules: [
        "Never claim US work authorization.",
        "Never write a cover letter.",
        "Salary expectation is left blank or set to negotiable.",
        "Marketing opt-ins are optional and left unchecked. Consent and acknowledgement boxes required to apply are checked.",
        "A Start Date or End Date that follows School, Degree or Field of Study fields is the degree's start or end, never the job start. The job start is only asked by fields that say available, start work, or join.",
      ],
    },
    fields: fields.map((f, i) => ({
      id: f.id,
      kind: f.kind,
      section: f.section,
      /** Labels of the two fields just above this one: "Start Date" after "School" and "Degree" is an education date. */
      preceded_by: fields.slice(Math.max(0, i - 2), i).map((p) => p.label).filter(Boolean),
      label: f.label,
      hint: f.hint,
      placeholder: f.placeholder,
      name: f.name,
      autocomplete: f.autocomplete,
      required: f.required,
      options: hasChoosableOptions(f) ? f.options.map((o) => o.label) : [],
    })),
  };
}

export function authForCountry(profile: Profile, country: string): { authorized: "Yes" | "No"; requires_sponsorship: "Yes" | "No" } {
  const ok = profile.workAuthorization.authorizedCountries.some((c) => country.toLowerCase().includes(c.toLowerCase()));
  return { authorized: ok ? "Yes" : "No", requires_sponsorship: ok ? "No" : "Yes" };
}

const TEXT_KINDS = new Set(["text", "email", "tel", "url", "number", "date", "textarea"]);

/** Input types whose value is fixed by the type itself; JEV only picks among the matching keys. */
const KEYS_BY_KIND: Partial<Record<string, string[]>> = {
  url: ["linkedin_url", "github_url", "website_url", "leave_blank"],
};

export function questionsFor(fields: DumpedField[]): Questions {
  const q: Questions = {};
  const keyCriteria: Record<string, string> = { ...ALL_KEYS };
  for (const [intent, desc] of Object.entries(BANK_INTENTS)) keyCriteria[`bank:${intent}`] = desc;
  for (const f of fields) {
    const section = f.section ? ` in the "${f.section}" section` : "";
    const i = fields.indexOf(f);
    const before = fields.slice(Math.max(0, i - 2), i).map((p) => p.label).filter(Boolean);
    const context = before.length ? ` (directly after the fields ${before.map((b) => `"${b.slice(0, 40)}"`).join(" and ")})` : "";
    const title = `Field "${f.label || f.placeholder || f.name}"${section}${context}${f.hint ? ` (${f.hint.slice(0, 120)})` : ""}${f.required ? ", required" : ", optional"}`;
    if (f.kind === "email" || f.kind === "tel") continue; // fixed by the input type; see planField
    const restricted = KEYS_BY_KIND[f.kind];
    if (restricted) {
      q[f.id] = choice(`${title}, an input of type ${f.kind}: which value should fill it?`, Object.fromEntries(restricted.map((k) => [k, keyCriteria[k] as string])));
    } else if (TEXT_KINDS.has(f.kind)) {
      q[f.id] = choice(`${title}: which value should fill it?`, keyCriteria);
    } else if (f.kind === "select" || f.kind === "radio" || f.kind === "combobox") {
      const opts = f.options;
      if (!hasChoosableOptions(f)) {
        // No list yet, or one too long to show (countries, schools): JEV names the value and code finds it in the list.
        q[f.id] = choice(`${title}: a dropdown ${opts.length ? `with ${opts.length} options, too many to list` : "whose options are not visible yet"}. Which value belongs in it?`, keyCriteria);
        continue;
      }
      const criteria: Record<string, string> = {};
      opts.forEach((o, i) => (criteria[`o${i}`] = o.label || o.value));
      criteria[NONE] = f.required ? "No option fits the candidate at all" : "Leave unselected: optional and not applicable";
      q[f.id] = choice(`${title}: which option is correct for the candidate?`, criteria);
    } else if (f.kind === "checkbox") {
      q[f.id] = noul(`${title}: should this checkbox be checked for the candidate?`, {
        true: "A consent, acknowledgement, terms or accuracy box needed to submit, or a true statement about the candidate",
        false: "A marketing or alert opt-in, or a statement that is not true of the candidate",
      });
    }
  }
  return q;
}

/** A list JEV can pick from directly: present, and short enough to show whole. */
export function hasChoosableOptions(f: DumpedField): boolean {
  return (f.kind === "select" || f.kind === "radio" || f.kind === "combobox") && f.options.length > 0 && f.options.length <= FORM.maxOptionsForJev;
}

const SALARY_LABEL = /salary|compensation|desired pay|expected pay|pay (rate|range|expectation)|hourly rate|wage/i;

const EDUCATION_NEIGHBOUR = /school|university|college|degree|field of study|major|education|graduat|start date|end date/i;
const DATE_LABEL = /^(start|end)\s*(date|month|year)?$/i;

/**
 * A Start Date or End Date select that sits right after education fields is
 * the degree's dates. That is a fact from the profile, so it is resolved in
 * code: month selects get the month (by name or number), year selects the year.
 * Returns null when the field is not one of these.
 */
export function educationDatePlan(f: DumpedField, previous: DumpedField[], profile: Profile): PlannedField | null {
  if (!DATE_LABEL.test(f.label.trim()) || (f.kind !== "select" && f.kind !== "combobox") || f.options.length === 0) return null;
  if (!previous.some((p) => EDUCATION_NEIGHBOUR.test(p.label))) return null;
  const edu = profile.education[0];
  if (!edu) return null;
  const isStart = /^start/i.test(f.label.trim());
  const month = isStart ? edu.startMonth : edu.gradMonth;
  const year = isStart ? edu.startYear : edu.gradYear;
  const labels = f.options.map((o) => o.label.trim());
  const looksLikeYears = labels.filter((l) => /^(19|20)\d\d$/.test(l)).length >= Math.max(2, labels.length / 2);
  const looksLikeMonths = labels.some((l) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(l)) || labels.filter((l) => /^(0?[1-9]|1[0-2])$/.test(l)).length >= 12;
  let opt: { value: string; label: string } | undefined;
  if (looksLikeYears) opt = f.options.find((o) => o.label.trim() === String(year) || o.value === String(year));
  else if (looksLikeMonths) {
    const name = monthName(month).toLowerCase();
    opt = f.options.find((o) => o.label.trim().toLowerCase().startsWith(name.slice(0, 3)) || o.label.trim() === String(month) || o.label.trim() === String(month).padStart(2, "0") || o.value === String(month));
  }
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required };
  if (!opt) return { ...base, action: "review", key: isStart ? "education_start_date" : "graduation_date", value: null, optionLabel: null, confidence: 0.4, note: `education ${isStart ? "start" : "end"} date, no matching option for ${monthName(month)} ${year}` };
  return { ...base, action: "fill", key: isStart ? "education_start_date" : "graduation_date", value: f.kind === "select" ? opt.value : opt.label, optionLabel: opt.label, confidence: 1, note: "degree date from the profile" };
}

export async function mapForm(jev: JevClient, profile: Profile, job: Job, dump: FieldsDump): Promise<FillPlan> {
  const planned: PlannedField[] = [];
  const startCost = jev.usage.costUsd;
  const resolvedInCode = new Set<string>();
  dump.fields.forEach((f, i) => {
    const p = educationDatePlan(f, dump.fields.slice(Math.max(0, i - 4), i), profile);
    if (p) {
      planned.push(p);
      resolvedInCode.add(f.id);
    }
  });
  const askable = dump.fields.filter((f) => f.kind !== "file" && !resolvedInCode.has(f.id));
  for (let i = 0; i < askable.length; i += FORM.fieldsPerCall) {
    const chunk = askable.slice(i, i + FORM.fieldsPerCall);
    const questions = questionsFor(chunk);
    const answers = Object.keys(questions).length ? await jev.decide(buildFormState(profile, job, dump, chunk), questions, `map-form:${job.company}`) : {};
    for (const f of chunk) planned.push(planField(f, answers[f.id], profile, job));
  }
  for (const f of dump.fields.filter((f) => f.kind === "file")) {
    const text = `${f.label} ${f.name} ${f.hint} ${f.selector}`;
    const isAutofill = /autofill|auto-fill|parse|prefill/i.test(text);
    const isResume = !isAutofill && (/resume|cv|curriculum/i.test(text) || !/cover|letter|transcript|portfolio|photo|other/i.test(text));
    planned.push({
      id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required,
      action: isResume ? "upload" : "skip", key: isResume ? "resume_upload" : "leave_blank",
      value: isResume ? profile.resume.path : null, optionLabel: null, confidence: 1,
      note: isResume ? null : isAutofill ? "autofill helper, skipped so it does not overwrite the plan" : "not a resume upload",
    });
  }
  const ordered = dump.fields.map((f) => planned.find((p) => p.id === f.id) as PlannedField);
  return {
    jobId: job.id,
    url: dump.url,
    fields: ordered,
    fills: ordered.filter((p) => p.action === "fill" && p.value !== null).map((p) => ({ selector: p.selector, kind: p.kind, value: p.value as string })),
    uploads: ordered.filter((p) => p.action === "upload").map((p) => ({ selector: p.selector, path: p.value as string })),
    drafts: ordered.filter((p) => p.action === "draft").map((p) => {
      const f = dump.fields.find((x) => x.id === p.id) as DumpedField;
      return { id: p.id, selector: p.selector, label: p.label, hint: f.hint, maxLength: f.maxLength, intent: p.key };
    }),
    reviews: ordered.filter((p) => p.action === "review").map((p) => {
      const f = dump.fields.find((x) => x.id === p.id) as DumpedField;
      return { id: p.id, selector: p.selector, kind: p.kind, label: p.label, options: f.options.map((o) => o.label), why: p.note ?? "low confidence" };
    }),
    submitSelectors: dump.submitSelectors,
    jevCostUsd: jev.usage.costUsd - startCost,
  };
}

export function planField(f: DumpedField, answer: Answer | undefined, profile: Profile, job: Job): PlannedField {
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null as string | null };
  if (f.kind === "email") return { ...base, action: "fill", key: "email", value: profile.email, confidence: 1, note: null };
  if (f.kind === "tel") {
    // National digits unless the placeholder or hint shows an international format.
    const intl = /\+\d|country code|international/i.test(`${f.placeholder} ${f.hint}`);
    return { ...base, action: "fill", key: intl ? "phone_with_country_code" : "phone", value: intl ? `${profile.phone.countryCode}${profile.phone.national}` : profile.phone.national, confidence: 1, note: null };
  }
  if (!answer) return { ...base, action: "review", key: "unknown", value: null, confidence: 0, note: "no answer" };

  if (f.kind === "checkbox") {
    const p = (answer as NoulAnswer).noul;
    if (p >= 0.7) return { ...base, action: "fill", key: "checked", value: "true", confidence: p, note: null };
    if (p <= 0.3) return { ...base, action: "skip", key: "unchecked", value: null, confidence: 1 - p, note: "left unchecked" };
    return { ...base, action: "review", key: "unknown", value: null, confidence: Math.max(p, 1 - p), note: "unsure whether to check" };
  }

  let a = answer as ChoiceAnswer;
  if (hasChoosableOptions(f)) {
    if (a.choice === NONE) {
      if (f.required) return { ...base, action: "review", key: "unknown", value: null, confidence: a.confidence, note: "required but no option fits" };
      return { ...base, action: "skip", key: "leave_blank", value: null, confidence: a.confidence, note: "optional, left unselected" };
    }
    const idx = parseInt(a.choice.replace(/^o/, ""), 10);
    const opt = f.options[idx];
    if (!opt) return { ...base, action: "review", key: "unknown", value: null, confidence: 0, note: "option index out of range" };
    const action = a.confidence >= FORM.reviewConfidence ? "fill" : "review";
    // Radios and comboboxes are matched by label in fillFields.js: radio value attributes are often missing or all "on".
    const value = f.kind === "select" ? opt.value : opt.label;
    return { ...base, action, key: `option:${a.choice}`, value, optionLabel: opt.label, confidence: a.confidence, note: a.confidence < FORM.autoConfidence ? `confidence ${a.confidence.toFixed(2)}` : null };
  }

  const key = a.choice;
  // Keys that would put the same text in the box are one answer, so their probabilities add up:
  // "country", "citizenship" and "work authorization country" all say Canada.
  const confidence = agreedConfidence(a, profile, job);
  a = { ...a, confidence };
  const note = a.confidence < FORM.autoConfidence ? `confidence ${a.confidence.toFixed(2)}` : null;
  const textLike = f.kind === "text" || f.kind === "textarea";
  // A salary box that will not submit empty gets the profile's standing wording, never a number the candidate did not give.
  if (f.required && textLike && SALARY_LABEL.test(f.label) && !profile.preferences.salaryExpectation && (key === "salary_expectation" || key === "leave_blank" || key === "unknown" || key === "free_text")) {
    return { ...base, action: "fill", key: "salary_expectation", value: profile.preferences.salaryIfRequired, confidence: a.confidence, note: "salary is required, so the standing wording is used" };
  }
  if (a.confidence < FORM.reviewConfidence) {
    // An open question is drafted whatever the confidence: the writer reads the question itself, not JEV's guess at its intent.
    if (f.kind === "textarea" && (key.startsWith("bank:") || key === "free_text")) return { ...base, action: "draft", key: key.startsWith("bank:") ? key.slice(5) : key, value: null, confidence: a.confidence, note: `intent is a guess (${a.confidence.toFixed(2)})` };
    return { ...base, action: "review", key, value: null, confidence: a.confidence, note: `low confidence, best guess ${key}` };
  }
  if (key.startsWith("bank:")) return { ...base, action: "draft", key: key.slice(5), value: null, confidence: a.confidence, note };
  if (isSpecialKey(key)) {
    if (key === "free_text") return { ...base, action: "draft", key: "free_text", value: null, confidence: a.confidence, note };
    if (key === "resume_upload") return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "text field mapped to resume; probably a link or name" };
    if (key === "leave_blank") return { ...base, action: f.required ? "review" : "skip", key, value: null, confidence: a.confidence, note: f.required ? "required but mapped to leave blank" : null };
    return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "unknown field" };
  }
  if (isProfileKey(key)) {
    const value = valueForJob(profile, job, key as FieldKey);
    if (value === null) {
      if (key === "gpa") return { ...base, action: f.required ? "fill" : "skip", key, value: f.required ? gpaValue(profile) : null, confidence: a.confidence, note: f.required ? "GPA given only because the field is required" : "GPA not volunteered" };
      return { ...base, action: f.required ? "review" : "skip", key, value: null, confidence: a.confidence, note: f.required ? "required but the profile has no value" : null };
    }
    return { ...base, action: "fill", key, value, confidence: a.confidence, note };
  }
  return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "unrecognized key" };
}

function agreedConfidence(a: ChoiceAnswer, profile: Profile, job: Job): number {
  const valueOf = (key: string) => (isProfileKey(key) ? valueForJob(profile, job, key as FieldKey) : null);
  const value = valueOf(a.choice);
  if (value === null) return a.confidence;
  const agreed = Object.entries(a.probabilities).reduce((sum, [key, p]) => (valueOf(key) === value ? sum + p : sum), 0);
  return Math.min(1, Math.max(a.confidence, agreed));
}

function gpaValue(profile: Profile): string | null {
  const g = profile.education[0]?.gpa;
  return g?.cumulative !== undefined ? g.cumulative.toFixed(2) : null;
}

/** Profile value for a key, with the two job-dependent keys resolved against the posting's country. */
export function valueForJob(profile: Profile, job: Job, key: FieldKey): string | null {
  if (isSpecialKey(key)) return null;
  if (key === "authorized_to_work" || key === "requires_sponsorship") {
    const tier = locationTier(job.locations);
    const country = tier === "vancouver" || tier === "canada" ? "Canada" : tier === "us" ? "United States" : "unknown";
    const auth = authForCountry(profile, country);
    return key === "authorized_to_work" ? auth.authorized : auth.requires_sponsorship;
  }
  return valueFor(profile, key);
}
