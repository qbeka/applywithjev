/**
 * Templates for the resume and the cover letter: the stock pair shipped with the tool, and any a
 * person registered from their own HTML. A template is a folder with resume.html and cover.html,
 * written in the small language of template.ts. Registering one checks its placeholders and
 * prints a test pair from the example profile, so a broken template is refused before a real job.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DOCUMENTS, PATHS } from "../config.js";
import { ProfileSchema, type Profile } from "../profile/schema.js";
import { COVER_VIEW_KEYS, placeholdersIn, renderTemplate, RESUME_VIEW_KEYS } from "./template.js";
import { coverView, printPdf, resumeView } from "./render.js";
import type { Tailored } from "./tailor.js";

export type Template = { name: string; dir: string; resume: string; cover: string; shipped: boolean };

const Active = z.object({ name: z.string() });

export function listTemplates(): Template[] {
  const read = (root: string, shipped: boolean): Template[] =>
    existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, "resume.html")))
          .map((d) => ({ name: d.name, dir: path.join(root, d.name), resume: path.join(root, d.name, "resume.html"), cover: path.join(root, d.name, "cover.html"), shipped }))
      : [];
  return [...read(DOCUMENTS.templatesShipped, true), ...read(DOCUMENTS.templatesLocal, false)];
}

export function activeTemplate(): Template {
  const all = listTemplates();
  let wanted = "default";
  try {
    if (existsSync(DOCUMENTS.activeTemplate)) wanted = Active.parse(JSON.parse(readFileSync(DOCUMENTS.activeTemplate, "utf8"))).name;
  } catch {
    wanted = "default";
  }
  const t = all.find((x) => x.name === wanted) ?? all.find((x) => x.name === "default");
  if (!t) throw new Error("the stock template is missing from src/documents/templates/default");
  return t;
}

export function useTemplate(name: string): Template {
  const t = listTemplates().find((x) => x.name === name);
  if (!t) throw new Error(`no template named ${name}. Registered: ${listTemplates().map((x) => x.name).join(", ")}`);
  mkdirSync(path.dirname(DOCUMENTS.activeTemplate), { recursive: true });
  writeFileSync(DOCUMENTS.activeTemplate, JSON.stringify({ name }));
  return t;
}

/** What a template must refer to, so the resume still says who the person is and what they did. */
const REQUIRED_RESUME = ["name", "contact", "experience", "education"];
const REQUIRED_COVER = ["name", "paragraphs"];

/** The placeholders a template uses that the view does not offer, and the required ones it lacks. */
export function checkTemplate(resumeHtml: string, coverHtml: string | null): string[] {
  const problems: string[] = [];
  const resumeKeys = new Set<string>([...RESUME_VIEW_KEYS, "title", "company", "location", "when", "bullets", "role", "link", "degree", "field", "minor", "school", "projects.length"]);
  const coverKeys = new Set<string>(COVER_VIEW_KEYS);
  for (const k of placeholdersIn(resumeHtml)) if (!resumeKeys.has(k)) problems.push(`resume.html uses {{${k}}}, which the tool does not provide`);
  for (const k of REQUIRED_RESUME) if (!placeholdersIn(resumeHtml).includes(k)) problems.push(`resume.html never uses {{${k}}}`);
  if (coverHtml !== null) {
    for (const k of placeholdersIn(coverHtml)) if (!coverKeys.has(k)) problems.push(`cover.html uses {{${k}}}, which the tool does not provide`);
    for (const k of REQUIRED_COVER) if (!placeholdersIn(coverHtml).includes(k)) problems.push(`cover.html never uses {{${k}}}`);
  }
  return problems;
}

/** A sample pair from the example profile, to prove a template renders and fits. */
const SAMPLE: Tailored = {
  headline: "Software Engineer Intern",
  summary: "A short summary written for the posting, three sentences long at most, that says what the candidate built and why it fits.",
  skills: ["TypeScript", "React", "Node.js", "PostgreSQL", "Python", "Git"],
  experience: [{ company: "Example Corp", title: "Software Engineer Intern", bullets: ["Shipped a feature used by many people.", "Wrote the tests that kept it working."] }],
  projects: [{ name: "Example App", bullets: ["Built and launched an iOS app."] }],
  coverLetter: { greeting: "Dear Hiring Team,", paragraphs: ["First paragraph, naming something specific about the posting.", "Second paragraph, tying two or three facts to the posting.", "Third paragraph, what the candidate wants to build there."], closing: "Sincerely," },
  keywordsCovered: [],
  keywordsMissing: [],
};

/**
 * Registers a folder as a template: copies it under documents/templates/<name>/, checks its
 * placeholders, and prints a test pair from the example profile. A folder that fails any step is
 * not kept. Returns the page counts of the test pair.
 */
export async function addTemplate(from: string, name: string): Promise<{ template: Template; resumePages: number; coverPages: number | null }> {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) throw new Error("a template name is lower-case letters, digits and dashes");
  const resumeSrc = path.join(from, "resume.html");
  if (!existsSync(resumeSrc)) throw new Error(`${from} has no resume.html`);
  const coverSrc = path.join(from, "cover.html");
  const resumeHtml = readFileSync(resumeSrc, "utf8");
  const coverHtml = existsSync(coverSrc) ? readFileSync(coverSrc, "utf8") : null;
  const problems = checkTemplate(resumeHtml, coverHtml);
  if (problems.length) throw new Error(`the template is not usable: ${problems.join("; ")}`);
  const profile: Profile = ProfileSchema.parse(JSON.parse(readFileSync(PATHS.profileExample, "utf8")));
  const dir = path.join(DOCUMENTS.templatesLocal, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  cpSync(from, dir, { recursive: true });
  const proof = path.join(dir, ".proof");
  mkdirSync(proof, { recursive: true });
  try {
    const resumePages = await printPdf(renderTemplate(resumeHtml, resumeView(profile, SAMPLE)), path.join(proof, "resume.pdf"));
    const coverPages = coverHtml ? await printPdf(renderTemplate(coverHtml, coverView(profile, { job: { company: "Example Corp", title: "Software Engineer Intern" } }, SAMPLE)), path.join(proof, "cover.pdf")) : null;
    if (resumePages > DOCUMENTS.resumePages + 1) throw new Error(`the sample resume ran to ${resumePages} pages; the template's layout is too loose`);
    return { template: { name, dir, resume: path.join(dir, "resume.html"), cover: path.join(dir, "cover.html"), shipped: false }, resumePages, coverPages };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
