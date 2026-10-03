/**
 * A small template language for the resume and the cover letter, so a person can bring their
 * own HTML: {{name}} prints a value escaped, {{{html}}} prints it as it is, {{#list}}...{{/list}}
 * repeats a block for each item (or once for a true value), {{^list}}...{{/list}} prints when the
 * list is empty, and {{.}} is the item itself. Nothing else, on purpose.
 */
import { escapeHtml } from "./render.js";

export type View = Record<string, unknown>;

const lookup = (stack: unknown[], key: string): unknown => {
  if (key === ".") return stack[stack.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx && typeof ctx === "object" && key in (ctx as Record<string, unknown>)) return (ctx as Record<string, unknown>)[key];
  }
  return undefined;
};

const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

export function renderTemplate(template: string, view: View): string {
  const walk = (src: string, stack: unknown[]): string => {
    let out = "";
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{{", i);
      if (open < 0) {
        out += src.slice(i);
        break;
      }
      out += src.slice(i, open);
      const close = src.indexOf("}}", open);
      if (close < 0) throw new Error("a {{ without its }} in the template");
      const tag = src.slice(open + 2, close).trim();
      i = close + 2;
      if (tag.startsWith("#") || tag.startsWith("^")) {
        const key = tag.slice(1).trim();
        const end = src.indexOf(`{{/${key}}}`, i);
        if (end < 0) throw new Error(`{{${tag}}} without its {{/${key}}}`);
        const block = src.slice(i, end);
        i = end + key.length + 5;
        const v = lookup(stack, key);
        const items = Array.isArray(v) ? v : v ? [v] : [];
        if (tag.startsWith("#")) for (const item of items) out += walk(block, [...stack, item]);
        else if (!items.length) out += walk(block, stack);
      } else if (tag.startsWith("{") && src[close + 2] === "}") {
        out += text(lookup(stack, tag.slice(1).trim()));
        i = close + 3;
      } else if (tag.startsWith("!")) {
        /* a comment */
      } else {
        out += escapeHtml(text(lookup(stack, tag)));
      }
    }
    return out;
  };
  return walk(template, [view]);
}

/** The names a template may use, so a custom one can be checked before it is trusted with a real job. */
export const RESUME_VIEW_KEYS = ["name", "headline", "contact", "summary", "skills", "skillList", "experience", "projects", "education"] as const;
export const COVER_VIEW_KEYS = ["name", "contact", "date", "company", "role", "greeting", "paragraphs", "closing"] as const;

/** The placeholders a template refers to. */
export const placeholdersIn = (template: string): string[] => [...new Set([...template.matchAll(/\{\{[#^{]?\s*([A-Za-z_.][A-Za-z0-9_.]*)/g)].map((m) => m[1] ?? "").filter((k) => k && k !== "."))];
