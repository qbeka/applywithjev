import { describe, expect, it } from "vitest";
import { checkExtras, checkKey, checkNode, checkProfile, checkResume, formatChecks, isReadyToRun, nextStep, type Check } from "../src/doctor.js";

const ok = (name: string): Check => ({ name, ok: true, detail: "fine", fix: "" });
const bad = (name: string, fix: string, optional = false): Check => ({ name, ok: false, detail: "missing", fix, optional });

describe("doctor", () => {
  it("accepts Node 22 and newer", () => {
    expect(checkNode("22.16.0").ok).toBe(true);
    expect(checkNode("20.11.1").ok).toBe(false);
  });
  it("wants a key, and never prints it", () => {
    expect(checkKey("").ok).toBe(false);
    // Built at run time, so no key-shaped text sits in the repository.
    const made = `sk-or-v1-${"k".repeat(12)}`;
    const c = checkKey(made);
    expect(c.ok).toBe(true);
    expect(JSON.stringify(c)).not.toContain(made);
    expect(checkKey("").fix).toMatch(/Do not paste the key into a chat/);
  });
  it("reads the example profile and names a missing one", () => {
    const { check, profile } = checkProfile(new URL("../data/profile.example.json", import.meta.url).pathname);
    expect(check.ok).toBe(true);
    expect(profile?.name.first).toBeTruthy();
    expect(checkProfile("/nowhere/profile.json").check).toMatchObject({ ok: false });
    expect(checkResume(null).ok).toBe(false);
  });
  it("names the first thing that blocks a run before anything optional", () => {
    const checks = [ok("Node.js"), bad("Your drafts", "write drafts", true), bad("OpenRouter key", "add the key"), bad("Your profile", "run setup")];
    expect(nextStep(checks)).toBe("add the key");
    expect(isReadyToRun(checks)).toBe(false);
    expect(formatChecks(checks)).toContain("Next step: add the key");
  });
  it("is ready when only optional things are missing, and still suggests them", () => {
    const checks = [ok("Node.js"), bad("Job queue", "run discover", true)];
    expect(isReadyToRun(checks)).toBe(true);
    expect(nextStep(checks)).toBe("run discover");
    expect(nextStep([ok("Node.js")])).toMatch(/Everything is in place/);
  });
  it("lists Gmail and signed-in sites as offers that never block or nag", () => {
    const extras = checkExtras(null, []);
    expect(extras.every((c) => c.optional && !c.ok)).toBe(true);
    expect(isReadyToRun([ok("Node.js"), ...extras])).toBe(true);
    expect(nextStep([ok("Node.js"), ...extras])).toMatch(/Everything is in place/);
    const set = checkExtras({ address: "someone@example.com", password: "x" }, [{ host: "jobs.example.com", url: "https://jobs.example.com", connectedAt: "", checkedAt: "" }]);
    expect(set.every((c) => c.ok)).toBe(true);
    expect(JSON.stringify(set)).not.toContain("someone@example.com");
  });
});
