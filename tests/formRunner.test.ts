import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isFormWrite } from "../src/browser/cdp.js";
import { closestOptions, pickOption } from "../src/browser/formRunner.js";

const hints = ["Edmonton", "Alberta", "AB", "Canada"];

describe("pickOption", () => {
  it("prefers an exact match, then a prefix, then a substring", () => {
    expect(pickOption(["Yes", "Yes, with conditions", "No"], "Yes", [])).toBe("Yes");
    expect(pickOption(["Bachelor's Degree", "Master's Degree"], "Bachelor", [])).toBe("Bachelor's Degree");
    expect(pickOption(["I am not a protected veteran", "I am a veteran"], "not a protected veteran", [])).toBe("I am not a protected veteran");
  });

  it("breaks ties with the candidate's own places", () => {
    expect(pickOption(["American Samoa +1", "Canada +1", "United States +1"], "+1", hints)).toBe("Canada +1");
    expect(pickOption(["Edmonton, Kentucky, United States", "Edmonton, Alberta, Canada"], "Edmonton", hints)).toBe("Edmonton, Alberta, Canada");
  });

  it("matches a place written another way, but only with one of the candidate's places named", () => {
    expect(pickOption(["Edmonton, AB, Canada", "Edmonton, KY, USA"], "Edmonton, Alberta, Canada", hints)).toBe("Edmonton, AB, Canada");
    expect(pickOption(["Edmonton, KY, USA"], "Edmonton, Alberta, Canada", hints)).toBeNull();
    // "AB" has to be a word of its own, not letters inside another word.
    expect(pickOption(["Edmonton, Abbotsford"], "Edmonton, Alberta, Canada", ["AB"])).toBeNull();
  });

  it("returns null rather than something merely similar", () => {
    expect(pickOption(["Ajou University", "Aalto University"], "University of Alberta", hints)).toBeNull();
    expect(pickOption(["Computer Science"], "Computing Science", [])).toBeNull();
    expect(pickOption(["Yes", "No"], "", [])).toBeNull();
  });
});

describe("closestOptions", () => {
  const disciplines = ["Accounting", "Biology", "Computer Engineering", "Computer Science", "Data Science", "History", "Information Science", "Physics"];
  it("keeps a short list whole", () => {
    expect(closestOptions(disciplines, "Computing Science", 40)).toEqual(disciplines);
  });
  it("cuts a long list to the options that share word stems with the wanted value", () => {
    const top = closestOptions(disciplines, "Computing Science", 4);
    expect(top).toHaveLength(4);
    expect(top[0]).toBe("Computer Science");
    expect(top).toContain("Computer Engineering");
    expect(top).not.toContain("History");
  });
});

describe("isFormWrite", () => {
  const form = "https://jobs.ashbyhq.com/acme/134c282c/application";
  it("counts the form's own saves and direct file uploads", () => {
    expect(isFormWrite("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSetFormValue", form)).toBe(true);
    expect(isFormWrite("https://acme-uploads.s3.us-east-1.amazonaws.com/", form)).toBe(true);
  });
  it("ignores analytics, error reporting and widgets from other sites", () => {
    expect(isFormWrite("https://api.rollbar.com/api/1/item/", form)).toBe(false);
    expect(isFormWrite("https://www.linkedin.com/talentwidgets/apply-with-linkedin", form)).toBe(false);
    expect(isFormWrite("https://api.pinterest.com/v3/coc_event/", "https://job-boards.greenhouse.io/embed/job_app?for=pinterest")).toBe(false);
    expect(isFormWrite("https://c.spl.greenhouse.io/com.snowplowanalytics.snowplow/tp2", "https://job-boards.greenhouse.io/embed/job_app?for=acme")).toBe(false);
    expect(isFormWrite("not a url", form)).toBe(false);
  });
});

describe("the in-page scripts", () => {
  it.each(["dumpFields.js", "fillFields.js", "pageHelpers.js"])("%s parses as one expression", (name) => {
    const src = readFileSync(new URL(`../src/forms/${name}`, import.meta.url), "utf8").replace("__PLAN__", "[]");
    expect(() => new Function(`return ${src.replace(/^\s*\/\/.*$/gm, "").trim().replace(/;$/, "")}`)).not.toThrow();
  });
  it("never dumps a password box and reports that one is present", () => {
    const src = readFileSync(new URL("../src/forms/dumpFields.js", import.meta.url), "utf8");
    expect(src).toMatch(/SKIP_TYPES = new Set\(\[[^\]]*"password"/);
    expect(src).toContain("out.hasPassword");
  });
});
