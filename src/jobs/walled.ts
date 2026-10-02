/**
 * Careers sites that put a login or an account in front of the form, or
 * show no form the runner can reach. The tool never creates accounts, so
 * jobs there are skipped before rating. The list starts from config and
 * grows: when an apply run meets such a page, the site is remembered here
 * and skipped by the next discover.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DISCOVER, PATHS } from "../config.js";

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export function learnedWalledHosts(file = PATHS.walledHosts): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

export function isWalled(url: string, learned: string[] = learnedWalledHosts()): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return DISCOVER.accountWalledHosts.some((h) => host.includes(h)) || learned.includes(host);
}

/** Records the site of a job that turned out to need a login. The big ATS hosts are never recorded: one company's settings say nothing about the rest. */
export function rememberWalledHost(url: string, file = PATHS.walledHosts): void {
  const host = hostOf(url);
  if (!host || /greenhouse\.io|lever\.co|ashbyhq\.com|rippling\.com|bamboohr\.com|smartrecruiters\.com|jobvite\.com/.test(host)) return;
  const hosts = learnedWalledHosts(file);
  if (hosts.includes(host)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...hosts, host].sort(), null, 2));
}
