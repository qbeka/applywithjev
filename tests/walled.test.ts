import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isWalled, learnedWalledHosts, rememberWalledHost } from "../src/jobs/walled.js";

const dir = mkdtempSync(path.join(tmpdir(), "awj-walled-"));
const file = path.join(dir, "walled-hosts.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("walled careers sites", () => {
  it("knows the configured ones and nothing else by default", () => {
    expect(isWalled("https://acme.eightfold.ai/careers/job/1", [])).toBe(true);
    expect(isWalled("https://careers.example.com/jobs/1", [])).toBe(false);
    expect(isWalled("not a url", [])).toBe(false);
  });
  it("remembers a site an apply run found walled, once", () => {
    expect(learnedWalledHosts(file)).toEqual([]);
    rememberWalledHost("https://careers.example.com/jobs/1?x=1", file);
    rememberWalledHost("https://careers.example.com/jobs/2", file);
    expect(learnedWalledHosts(file)).toEqual(["careers.example.com"]);
    expect(isWalled("https://careers.example.com/jobs/3", learnedWalledHosts(file))).toBe(true);
  });
  it("never blames a shared job board for one company's page", () => {
    rememberWalledHost("https://job-boards.greenhouse.io/acme/jobs/1", file);
    rememberWalledHost("https://jobs.ashbyhq.com/acme/134c282c-2837-44a8-9f7c-74ca39486490", file);
    expect(learnedWalledHosts(file)).toEqual(["careers.example.com"]);
  });
});
