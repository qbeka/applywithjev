/**
 * A minimal Chrome DevTools Protocol client for the fill runner. It drives a
 * dedicated, visible Chrome window with its own profile, so a whole form is
 * filled with real input events in seconds and the user can watch, fix and
 * take over. No dependency: Node 22 ships fetch and WebSocket.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { BROWSER } from "../config.js";

export type Target = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string };

const base = () => `http://127.0.0.1:${BROWSER.port}`;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function listTargets(): Promise<Target[] | null> {
  try {
    const res = await fetch(`${base()}/json/list`, { signal: AbortSignal.timeout(1500) });
    return ((await res.json()) as Target[]).filter((t) => t.type === "page");
  } catch {
    return null;
  }
}

/** Starts the runner's Chrome if it is not already listening. The window stays open after the CLI exits. */
export async function ensureBrowser(): Promise<void> {
  if (await listTargets()) return;
  mkdirSync(BROWSER.profileDir, { recursive: true });
  const child = spawn(
    BROWSER.chromePath,
    [
      `--remote-debugging-port=${BROWSER.port}`,
      `--user-data-dir=${BROWSER.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // A window behind another one would otherwise run its timers once a second.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,1000",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await listTargets()) return;
    await sleep(250);
  }
  throw new Error(`Chrome did not start on port ${BROWSER.port}. Is ${BROWSER.chromePath} installed?`);
}

export async function newTab(url: string): Promise<Target> {
  const res = await fetch(`${base()}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return (await res.json()) as Target;
}

export async function closeTab(id: string): Promise<void> {
  await fetch(`${base()}/json/close/${id}`).catch(() => undefined);
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

type Sent = { url: string; status: number | null; failed: boolean };

export class Page {
  private seq = 0;
  private pending = new Map<number, Pending>();
  /** Writes the page itself makes (POST, PUT, PATCH): some forms save every field to their server as it changes. */
  private writes = new Map<string, Sent>();
  private inflight = new Set<string>();
  private constructor(private ws: WebSocket, readonly targetId: string) {}

  static async attach(target: Target): Promise<Page> {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not attach to the tab"));
    });
    const page = new Page(ws, target.id);
    ws.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (m.id === undefined) {
        if (m.method && m.params) page.onNetwork(m.method, m.params);
        return;
      }
      const p = page.pending.get(m.id);
      if (!p) return;
      page.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    };
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("DOM.enable");
    await page.send("Network.enable");
    // Lets a tab that is not the frontmost one keep focus semantics, so dropdowns open.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return page;
  }

  private onNetwork(method: string, params: Record<string, unknown>): void {
    const id = params.requestId as string | undefined;
    if (!id) return;
    if (method === "Network.requestWillBeSent") {
      const req = params.request as { url: string; method: string };
      if (!/^(POST|PUT|PATCH)$/.test(req.method) || /google|recaptcha|hcaptcha|sentry|datadog|segment|analytics|amplitude|doubleclick|facebook|linkedin\.com\/li|clarity/i.test(req.url)) return;
      this.writes.set(id, { url: req.url, status: null, failed: false });
      this.inflight.add(id);
    } else if (method === "Network.responseReceived" && this.writes.has(id)) {
      const w = this.writes.get(id) as Sent;
      w.status = (params.response as { status: number }).status;
      w.failed = w.status >= 400;
    } else if (method === "Network.loadingFinished") {
      this.inflight.delete(id);
    } else if (method === "Network.loadingFailed" && this.writes.has(id)) {
      // Only a request that never got an answer failed. An answered one with no body (204) also ends here.
      const w = this.writes.get(id) as Sent;
      if (w.status === null) w.failed = true;
      this.inflight.delete(id);
    }
  }

  /** Resolves once the page has no write of its own in flight, or after the limit. True when it went quiet. */
  async writesSettled(limitMs: number): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    while (this.inflight.size && Date.now() < deadline) await sleep(40);
    return this.inflight.size === 0;
  }

  /** How many of the page's own writes were made and how many failed since the last call. */
  takeWrites(): { made: number; failed: string[] } {
    if (process.env.AWJ_TRACE) for (const [id, w] of this.writes) console.error(`[net] ${w.status ?? (this.inflight.has(id) ? "in flight" : "?")} ${w.url.slice(0, 110)}`);
    const all = [...this.writes.values()];
    // Writes still on their way stay tracked, so a later wait or count still sees them.
    for (const id of [...this.writes.keys()]) if (!this.inflight.has(id)) this.writes.delete(id);
    return { made: all.length, failed: all.filter((w) => w.failed).map((w) => `${w.status ?? "no answer"} ${w.url.slice(0, 80)}`) };
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates a fixed expression in the page and returns its JSON value. For anything with a value in it, use call. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /**
   * Calls a function in the page with JSON arguments. Values travel as arguments, never spliced
   * into source text, so nothing read from a page or a file can become code.
   */
  async call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const root = await this.send<{ result: { objectId: string } }>("Runtime.evaluate", { expression: "globalThis" });
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.callFunctionOn", {
      functionDeclaration: fn,
      objectId: root.result.objectId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /** Calls one of the helpers that pageHelpers.js installs on the page. */
  awj<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.call<T>("function (method, ...args) { return window.__awj[method](...args); }", method, ...args);
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  async bringToFront(): Promise<void> {
    await this.send("Page.bringToFront");
  }

  async click(x: number, y: number): Promise<void> {
    const at = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
  }

  async type(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async key(key: "Escape" | "Enter" | "Backspace" | "Tab"): Promise<void> {
    const code = { Escape: 27, Enter: 13, Backspace: 8, Tab: 9 }[key];
    const ev = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  }

  /** Puts local files on a file input, the way a user's file picker would. */
  async setFiles(selector: string, files: string[]): Promise<boolean> {
    const doc = await this.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const found = await this.send<{ nodeId: number }>("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!found.nodeId) return false;
    await this.send("DOM.setFileInputFiles", { nodeId: found.nodeId, files });
    return true;
  }

  close(): void {
    this.ws.close();
  }
}
