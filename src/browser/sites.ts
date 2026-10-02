/**
 * Sites the person has signed in to. Signing in is theirs to do: `connect`
 * opens the page in the runner's own Chrome window and waits. The tool types
 * nothing on a page with a password box, here or anywhere. The session stays
 * in the runner's Chrome profile, so one sign-in lasts until the site ends it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PATHS, SITES } from "../config.js";
import { closeTab, ensureBrowser, newTab, Page, sleep } from "./cdp.js";

export const Site = z.object({
  /** The host as it appears in job links, lower case. */
  host: z.string(),
  /** The page the person signed in from. */
  url: z.string(),
  connectedAt: z.string(),
  /** When the tool last saw the site signed in. */
  checkedAt: z.string(),
});
export type Site = z.infer<typeof Site>;
const SitesFile = z.array(Site);

export const hostOf = (url: string): string => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export function loadSites(file = PATHS.sites): Site[] {
  if (!existsSync(file)) return [];
  try {
    return SitesFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

export function saveSites(sites: Site[], file = PATHS.sites): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sites, null, 2));
}

export const connectedHosts = (sites: Site[] = loadSites()): string[] => sites.map((s) => s.host);
export const isConnected = (url: string, sites: Site[] = loadSites()): boolean => !!hostOf(url) && sites.some((s) => s.host === hostOf(url));

export function addSite(sites: Site[], url: string, now = new Date().toISOString()): Site[] {
  const host = hostOf(url);
  const before = sites.find((s) => s.host === host);
  return [...sites.filter((s) => s.host !== host), { host, url, connectedAt: before?.connectedAt ?? now, checkedAt: now }].sort((a, b) => a.host.localeCompare(b.host));
}

/** One look at the page while the person signs in. */
export type Seen = { at: number; hasPassword: boolean };

/**
 * Whether the sign-in is over, from what the page showed. It is over when a password box was on
 * the page at some point and none has been for SITES.quietMs. A page that never showed one says
 * nothing: the person may be signed in already, or may not have opened the sign-in page yet.
 */
export function signInState(seen: Seen[], quietMs: number = SITES.quietMs): "waiting" | "signed_in" | "no_sign_in_seen" {
  const lastWithBox = [...seen].reverse().find((s) => s.hasPassword);
  if (!lastWithBox) return "no_sign_in_seen";
  const latest = seen[seen.length - 1] as Seen;
  return !latest.hasPassword && latest.at - lastWithBox.at >= quietMs ? "signed_in" : "waiting";
}

/** Fixed text: looks for a password box a person could type into. Reads nothing else. */
const HAS_PASSWORD = "[...document.querySelectorAll('input[type=password]')].some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })";

/**
 * Opens the site and waits for the person to sign in. Nothing is typed or clicked by the tool.
 * Returns what happened; the caller records the site when it is "signed_in".
 */
export async function waitForSignIn(url: string, opts: { timeoutMs?: number; onTick?: (state: ReturnType<typeof signInState>, secondsLeft: number) => void } = {}): Promise<ReturnType<typeof signInState>> {
  await ensureBrowser();
  const target = await newTab(url);
  const page = await Page.attach(target);
  const seen: Seen[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? SITES.connectTimeoutMs);
  try {
    await page.bringToFront();
    let state: ReturnType<typeof signInState> = "no_sign_in_seen";
    while (Date.now() < deadline) {
      await sleep(SITES.pollMs);
      try {
        seen.push({ at: Date.now(), hasPassword: await page.evaluate<boolean>(HAS_PASSWORD) });
      } catch {
        continue; // between two pages
      }
      state = signInState(seen);
      opts.onTick?.(state, Math.round((deadline - Date.now()) / 1000));
      if (state === "signed_in") break;
    }
    return state;
  } finally {
    page.close();
    await closeTab(target.id);
  }
}

/** Signs the runner's Chrome out of a site by removing what the site stored there: its cookies and its storage. */
export async function forgetSite(host: string): Promise<void> {
  await ensureBrowser();
  const target = await newTab("about:blank");
  const page = await Page.attach(target);
  try {
    const { cookies } = await page.send<{ cookies: { name: string; domain: string; path: string }[] }>("Network.getCookies", { urls: [`https://${host}/`] });
    for (const c of cookies) await page.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
    await page.send("Storage.clearDataForOrigin", { origin: `https://${host}`, storageTypes: "all" });
  } finally {
    page.close();
    await closeTab(target.id);
  }
}
