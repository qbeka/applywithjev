import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/profile/schema.js";
import { PROFILE_KEYS, profileFacts, valueFor } from "../src/profile/fieldKeys.js";
import { authForCountry, educationDatePlan, hasChoosableOptions, planField, questionsFor, valueForJob } from "../src/forms/mapForm.js";
import { FieldsDump, type DumpedField } from "../src/forms/fields.js";
import type { Job } from "../src/jobs/normalize.js";

const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
const job = (locations: string[]): Job => ({ id: "j", source: "t", company: "Acme", title: "SWE Intern", url: "https://x", ats: "greenhouse", locations, postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null });
const field = (over: Partial<DumpedField>): DumpedField => ({ id: "f0", selector: "#x", kind: "text", name: "", label: "", hint: "", placeholder: "", required: false, value: "", options: [], accept: "", maxLength: null, autocomplete: "", buttonGroup: false, section: "", ...over });

describe("profile field keys", () => {
  it("has a value or a deliberate null for every key", () => {
    for (const key of Object.keys(PROFILE_KEYS) as Array<keyof typeof PROFILE_KEYS>) {
      expect(() => valueFor(profile, key)).not.toThrow();
    }
    expect(valueFor(profile, "full_name")).toBe("Ada Lovelace");
    expect(valueFor(profile, "phone_with_country_code")).toBe("+15555550123");
    expect(valueFor(profile, "graduation_date")).toBe("April 2027");
    expect(valueFor(profile, "salary_expectation")).toBeNull();
    expect(valueFor(profile, "gpa")).toBeNull();
  });
  it("flattens facts for a JEV state without empty values", () => {
    const facts = profileFacts(profile);
    expect(facts.email).toBe("ada@example.com");
    expect(facts).not.toHaveProperty("salary_expectation");
  });
});

describe("work authorization per posting country", () => {
  it("answers truthfully for Canada and the US", () => {
    expect(authForCountry(profile, "Canada")).toEqual({ authorized: "Yes", requires_sponsorship: "No" });
    expect(authForCountry(profile, "United States")).toEqual({ authorized: "No", requires_sponsorship: "Yes" });
    expect(valueForJob(profile, job(["Toronto, ON"]), "authorized_to_work")).toBe("Yes");
    expect(valueForJob(profile, job(["Austin, TX"]), "requires_sponsorship")).toBe("Yes");
  });
});

describe("questionsFor", () => {
  it("asks a key choice for text fields, an option choice for selects, a noul for checkboxes", () => {
    const q = questionsFor([
      field({ id: "f0", kind: "text", label: "First name" }),
      field({ id: "f1", kind: "select", label: "Are you authorized to work in Canada?", options: [{ value: "y", label: "Yes" }, { value: "n", label: "No" }] }),
      field({ id: "f2", kind: "checkbox", label: "I agree to the privacy policy" }),
      field({ id: "f3", kind: "file", label: "Resume" }),
    ]);
    expect(q.f0?.type).toBe("choice");
    expect(Object.keys((q.f0 as { criteria: Record<string, string> }).criteria)).toContain("first_name");
    expect(Object.keys((q.f0 as { criteria: Record<string, string> }).criteria)).toContain("bank:why_company");
    expect((q.f1 as { criteria: Record<string, string> }).criteria).toMatchObject({ o0: "Yes", o1: "No" });
    expect(q.f2?.type).toBe("noul");
    expect(q.f3).toBeUndefined();
  });
  it("does not ask about tel and email inputs, and restricts url inputs to link keys", () => {
    const q = questionsFor([field({ id: "t", kind: "tel", label: "Phone Number" }), field({ id: "e", kind: "email", label: "Email" }), field({ id: "u", kind: "url", label: "LinkedIn" })]);
    expect(q.t).toBeUndefined();
    expect(q.e).toBeUndefined();
    expect(Object.keys((q.u as { criteria: Record<string, string> }).criteria)).toEqual(["linkedin_url", "github_url", "website_url", "leave_blank"]);
  });
  it("fills tel and email inputs from the input type alone", () => {
    const j = job(["Toronto, ON"]);
    expect(planField(field({ kind: "tel", label: "Phone Number" }), undefined, profile, j)).toMatchObject({ action: "fill", value: "5555550123" });
    expect(planField(field({ kind: "tel", label: "Phone", placeholder: "+1 555 555 5555" }), undefined, profile, j)).toMatchObject({ action: "fill", value: "+15555550123" });
    expect(planField(field({ kind: "email", label: "Personal Email" }), undefined, profile, j)).toMatchObject({ action: "fill", value: "ada@example.com" });
  });
  it("puts the section into the question", () => {
    const q = questionsFor([field({ id: "s", kind: "text", label: "Start Date", section: "Education" })]);
    expect((q.s as { instructions: string }).instructions).toContain('in the "Education" section');
  });
});

describe("planField", () => {
  const j = job(["Toronto, ON"]);
  it("fills a confidently mapped profile key", () => {
    const p = planField(field({ label: "Email" }), { type: "choice", choice: "email", probabilities: {}, confidence: 0.97 }, profile, j);
    expect(p).toMatchObject({ action: "fill", key: "email", value: "ada@example.com" });
  });
  it("sends low-confidence answers to review", () => {
    const p = planField(field({ label: "Favourite colour" }), { type: "choice", choice: "email", probabilities: {}, confidence: 0.3 }, profile, j);
    expect(p.action).toBe("review");
  });
  it("turns bank intents and free_text into drafts", () => {
    expect(planField(field({ kind: "textarea", label: "Why Acme?" }), { type: "choice", choice: "bank:why_company", probabilities: {}, confidence: 0.9 }, profile, j)).toMatchObject({ action: "draft", key: "why_company" });
    expect(planField(field({ kind: "textarea", label: "Anything else?" }), { type: "choice", choice: "free_text", probabilities: {}, confidence: 0.9 }, profile, j).action).toBe("draft");
  });
  it("picks select options by index and leaves optional ones unselected", () => {
    const sel = field({ kind: "select", label: "Gender", options: [{ value: "m", label: "Male" }, { value: "f", label: "Female" }] });
    expect(planField(sel, { type: "choice", choice: "o1", probabilities: {}, confidence: 0.95 }, profile, j)).toMatchObject({ action: "fill", value: "f", optionLabel: "Female" });
    expect(planField(sel, { type: "choice", choice: "__none__", probabilities: {}, confidence: 0.9 }, profile, j).action).toBe("skip");
    expect(planField({ ...sel, required: true }, { type: "choice", choice: "__none__", probabilities: {}, confidence: 0.9 }, profile, j).action).toBe("review");
  });
  it("gives the GPA only when the field is required", () => {
    const a = { type: "choice" as const, choice: "gpa", probabilities: {}, confidence: 0.95 };
    expect(planField(field({ label: "GPA" }), a, profile, j)).toMatchObject({ action: "skip" });
    expect(planField(field({ label: "GPA", required: true }), a, profile, j)).toMatchObject({ action: "fill", value: "3.50" });
  });
  it("checks consent boxes and leaves opt-ins alone", () => {
    expect(planField(field({ kind: "checkbox", label: "I certify the above is accurate" }), { type: "noul", noul: 0.95 }, profile, j)).toMatchObject({ action: "fill", value: "true" });
    expect(planField(field({ kind: "checkbox", label: "Send me job alerts" }), { type: "noul", noul: 0.05 }, profile, j).action).toBe("skip");
  });
  it("never fills salary", () => {
    const p = planField(field({ label: "Salary expectation" }), { type: "choice", choice: "salary_expectation", probabilities: {}, confidence: 0.95 }, profile, j);
    expect(p.action).toBe("skip");
  });
});

describe("captured form dumps", () => {
  it.each(["greenhouse", "ashby", "lever"])("%s dump parses and has no invisible validation inputs", (ats) => {
    const dump = FieldsDump.parse(JSON.parse(readFileSync(new URL(`./fixtures/dump-${ats}.json`, import.meta.url), "utf8")));
    expect(dump.fields.length).toBeGreaterThan(5);
    expect(dump.fields.every((f) => f.id && f.selector && f.label !== undefined)).toBe(true);
    const labels = dump.fields.filter((f) => f.kind !== "file" && f.kind !== "checkbox").map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.keys(questionsFor(dump.fields)).length).toBe(dump.fields.filter((f) => !["file", "email", "tel"].includes(f.kind)).length);
  });
});

describe("educationDatePlan", () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
  const years = Array.from({ length: 10 }, (_, i) => ({ value: String(2030 - i), label: String(2030 - i) }));
  const school = field({ id: "s", label: "School" });
  const degree = field({ id: "d", kind: "select", label: "Degree", options: [{ value: "b", label: "Bachelor's" }] });
  it("resolves degree start and end selects from the profile", () => {
    expect(educationDatePlan(field({ id: "m", kind: "select", label: "Start Date", options: months }), [school, degree], profile)).toMatchObject({ action: "fill", value: "9", key: "education_start_date" });
    expect(educationDatePlan(field({ id: "y", kind: "select", label: "Start Date", options: years }), [school, degree], profile)).toMatchObject({ action: "fill", value: "2024" });
    expect(educationDatePlan(field({ id: "e", kind: "select", label: "End Date", options: [{ value: "x", label: "April" }, { value: "y", label: "May" }] }), [degree], profile)).toMatchObject({ action: "fill", value: "x", optionLabel: "April" });
    expect(educationDatePlan(field({ id: "ey", kind: "select", label: "End Date", options: years }), [degree], profile)).toMatchObject({ action: "fill", value: "2027" });
  });
  it("leaves job start dates and unrelated selects to JEV", () => {
    expect(educationDatePlan(field({ id: "j", kind: "select", label: "Start Date", options: months }), [field({ label: "Phone" })], profile)).toBeNull();
    expect(educationDatePlan(field({ id: "k", kind: "select", label: "Country", options: years }), [degree], profile)).toBeNull();
  });
  it("asks for review when no option matches", () => {
    expect(educationDatePlan(field({ id: "r", kind: "select", label: "Start Date", options: [{ value: "a", label: "2010" }, { value: "b", label: "2011" }] }), [degree], profile)?.action).toBe("review");
  });
});

describe("long option lists, salary boxes and split confidence", () => {
  const j = job(["Toronto, ON"]);
  const many = Array.from({ length: 60 }, (_, i) => ({ value: `v${i}`, label: `Country ${i}` }));
  it("asks for a value, not an option index, when a list is too long to show", () => {
    const long = field({ kind: "select", label: "Country", options: many });
    expect(hasChoosableOptions(long)).toBe(false);
    expect(hasChoosableOptions(field({ kind: "select", label: "Country", options: many.slice(0, 5) }))).toBe(true);
    const q = questionsFor([long]);
    expect(Object.keys((q.f0 as { criteria: Record<string, string> }).criteria)).toContain("country");
    expect(planField(long, { type: "choice", choice: "country", probabilities: { country: 1 }, confidence: 1 }, profile, j)).toMatchObject({ action: "fill", value: "Canada" });
  });
  it("puts the standing wording in a salary box that will not submit empty, and leaves an optional one blank", () => {
    const answer = { type: "choice" as const, choice: "salary_expectation", probabilities: {}, confidence: 0.9 };
    expect(planField(field({ label: "Desired Pay", required: true }), answer, profile, j)).toMatchObject({ action: "fill", value: "Negotiable" });
    expect(planField(field({ label: "Salary expectations", required: false }), answer, profile, j).action).toBe("skip");
  });
  it("adds up the probability of keys that would write the same value", () => {
    const split = { type: "choice" as const, choice: "country", probabilities: { country: 0.4, citizenship: 0.35, work_authorization_country: 0.2, city: 0.05 }, confidence: 0.4 };
    const planned = planField(field({ label: "In which country will you be based?" }), split, profile, j);
    expect(planned).toMatchObject({ action: "fill", value: "Canada" });
    expect(planned.confidence).toBeGreaterThan(0.9);
  });
  it("drafts an open question even when its intent is only a guess", () => {
    const guess = { type: "choice" as const, choice: "bank:why_company", probabilities: {}, confidence: 0.3 };
    expect(planField(field({ kind: "textarea", label: "What motivates you?" }), guess, profile, j)).toMatchObject({ action: "draft", key: "why_company" });
    expect(planField(field({ kind: "text", label: "Mystery" }), { ...guess, choice: "city" }, profile, j).action).toBe("review");
  });
});

