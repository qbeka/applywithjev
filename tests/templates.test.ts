import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placeholdersIn, renderTemplate } from "../src/documents/template.js";
import { checkTemplate } from "../src/documents/templates.js";

describe("the template language", () => {
  it("prints values escaped, raw with three braces, and repeats blocks", () => {
    const out = renderTemplate("<h1>{{name}}</h1>{{{raw}}}<ul>{{#items}}<li>{{.}}</li>{{/items}}</ul>{{^none}}empty{{/none}}{{#person}}{{first}} {{last}}{{/person}}", { name: "A <b>", raw: "<i>x</i>", items: ["one", "two"], none: [], person: { first: "Ada", last: "Lovelace" } });
    expect(out).toBe("<h1>A &lt;b&gt;</h1><i>x</i><ul><li>one</li><li>two</li></ul>emptyAda Lovelace");
  });
  it("reads an outer value from inside a block, and prints nothing for a missing one", () => {
    expect(renderTemplate("{{#rows}}{{name}}:{{.}};{{/rows}}{{missing}}", { name: "N", rows: ["a", "b"] })).toBe("N:a;N:b;");
  });
  it("refuses an unclosed block", () => {
    expect(() => renderTemplate("{{#x}}no end", { x: [1] })).toThrow(/without its/);
  });
  it("lists the placeholders a template uses", () => {
    expect(placeholdersIn("{{name}} {{#experience}}{{title}}{{/experience}} {{{raw}}} {{.}}")).toEqual(["name", "experience", "title", "raw"]);
  });
});

describe("checking a template before it is trusted", () => {
  const stock = new URL("../src/documents/templates/default/", import.meta.url);
  it("accepts the stock pair", () => {
    expect(checkTemplate(readFileSync(new URL("resume.html", stock), "utf8"), readFileSync(new URL("cover.html", stock), "utf8"))).toEqual([]);
  });
  it("names a placeholder the tool does not provide and a required one that is missing", () => {
    const problems = checkTemplate("<p>{{name}} {{salary}}</p>", "<p>{{name}}</p>");
    expect(problems).toContain("resume.html uses {{salary}}, which the tool does not provide");
    expect(problems).toContain("resume.html never uses {{contact}}");
    expect(problems).toContain("cover.html never uses {{paragraphs}}");
  });
});
