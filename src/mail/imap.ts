/**
 * A minimal IMAP reader on Node's own TLS socket: sign in, open the mailbox
 * read-only, search by date, fetch headers and the start of a body. That is
 * all the tool needs from mail, and all this client can do: it has no command
 * that changes, moves, sends or deletes anything.
 *
 * The parsers are pure functions over bytes, so they are tested offline.
 */
import type net from "node:net";
import tls from "node:tls";
import { MAIL } from "../config.js";
import { decodeEntities, htmlToText } from "../util/text.js";

export type Reply = { line: string; literals: Buffer[] };
export type Parsed = { replies: Reply[]; status: "OK" | "NO" | "BAD"; text: string; consumed: number } | null;

/**
 * Reads one command's answer out of the bytes received so far: every untagged reply, then the
 * tagged line that ends it. A reply may carry literals ("{123}" then 123 raw bytes); each is
 * taken out and its place in the line marked with "{}". Returns null while the answer is incomplete.
 */
export function parseAnswer(buffer: Buffer, tag: string): Parsed {
  const replies: Reply[] = [];
  let at = 0;
  let current: Reply | null = null;
  for (;;) {
    const eol = buffer.indexOf("\r\n", at);
    if (eol < 0) return null;
    const piece = buffer.subarray(at, eol).toString("utf8");
    at = eol + 2;
    const literal = /\{(\d+)\}$/.exec(piece);
    if (!current) current = { line: "", literals: [] };
    if (literal) {
      const size = Number(literal[1]);
      if (buffer.length < at + size) return null;
      current.line += piece.slice(0, piece.length - literal[0].length) + "{}";
      current.literals.push(buffer.subarray(at, at + size));
      at += size;
      continue;
    }
    current.line += piece;
    const done = current;
    current = null;
    if (done.line.startsWith(`${tag} `)) {
      const [, status = "BAD", text = ""] = /^\S+ (OK|NO|BAD)\s?(.*)$/.exec(done.line) ?? [];
      return { replies, status: status as "OK" | "NO" | "BAD", text, consumed: at };
    }
    replies.push(done);
  }
}

/** A string as IMAP wants it quoted. */
export const quoted = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** 2026-10-02 as IMAP's 2-Oct-2026. */
export function imapDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** The mailbox that holds all mail (Gmail's "All Mail", whatever its name in the account's language), from a LIST answer. */
export function allMailbox(replies: Reply[]): string {
  for (const r of replies) {
    const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/.exec(r.line);
    if (!m || !/\\All\b/i.test(m[1] ?? "")) continue;
    const name = (m[2] ?? "").trim();
    return name === "{}" ? (r.literals[0]?.toString("utf8") ?? "INBOX") : name.replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1");
  }
  return "INBOX";
}

const decodeBytes = (bytes: Buffer, charset: string): string => {
  try {
    return new TextDecoder(charset.toLowerCase() === "utf8" ? "utf-8" : charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
};

const fromQuotedPrintable = (s: string): Buffer => {
  const out: number[] = [];
  const text = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === "=" ? text.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
};

/** Header text with RFC 2047 words ("=?UTF-8?B?...?=") turned back into characters. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) =>
      decodeBytes(enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : fromQuotedPrintable(data.replace(/_/g, " ")), charset),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Header fields of a message, names in lower case, folded lines joined. */
export function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!(name in out)) out[name] = line.slice(colon + 1).trim();
  }
  return out;
}

export type Sender = { name: string; address: string; domain: string };

export function parseSender(from: string): Sender {
  const decoded = decodeHeader(from);
  const address = (/<([^>]+)>/.exec(decoded)?.[1] ?? /[^\s<>"]+@[^\s<>"]+/.exec(decoded)?.[0] ?? "").toLowerCase();
  const name = decoded.replace(/<[^>]*>/, "").replace(/^"|"$/g, "").replace(/"/g, "").trim();
  return { name: name === address ? "" : name, address, domain: address.split("@")[1] ?? "" };
}

const param = (header: string, name: string): string => {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header);
  return m ? (m[1] ?? m[2] ?? "") : "";
};

/**
 * The readable text of a message: its plain-text part, or its HTML part as text. Attachments are
 * ignored. The message may be cut short (only its first bytes are fetched), so a part that ends
 * early is read as far as it goes.
 */
export function messageText(raw: Buffer | string): string {
  const source = typeof raw === "string" ? raw : raw.toString("latin1");
  const split = source.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? source : source.slice(0, split));
  const body = split < 0 ? "" : source.slice(split).replace(/^\r?\n\r?\n/, "");
  const type = headers["content-type"] ?? "text/plain";
  if (/^multipart\//i.test(type)) {
    const boundary = param(type, "boundary");
    if (!boundary) return "";
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--")).map((p) => p.replace(/^\r?\n/, ""));
    const texts = parts.map((p) => ({ type: parseHeaders(p.slice(0, Math.max(0, p.search(/\r?\n\r?\n/))))["content-type"] ?? "text/plain", text: messageText(p) }));
    return (texts.find((t) => /^text\/plain/i.test(t.type) && t.text) ?? texts.find((t) => /^(text\/html|multipart\/)/i.test(t.type) && t.text) ?? { text: "" }).text;
  }
  if (!/^text\//i.test(type)) return "";
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const bytes = encoding === "base64" ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64") : encoding === "quoted-printable" ? fromQuotedPrintable(body) : Buffer.from(body, "latin1");
  const text = decodeBytes(bytes, param(type, "charset") || "utf-8");
  return (/^text\/html/i.test(type) ? htmlToText(text) : decodeEntities(text)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export type MailHeader = { uid: number; from: Sender; subject: string; date: string; messageId: string };

/** One message's header fields from a FETCH reply. */
export function headerFromFetch(reply: Reply): MailHeader | null {
  const uid = Number(/\bUID (\d+)/.exec(reply.line)?.[1] ?? NaN);
  const block = reply.literals[0];
  if (!Number.isFinite(uid) || !block) return null;
  const h = parseHeaders(block.toString("latin1"));
  const when = new Date(h.date ?? "");
  return { uid, from: parseSender(h.from ?? ""), subject: decodeHeader(h.subject ?? ""), date: Number.isNaN(when.getTime()) ? "" : when.toISOString(), messageId: (h["message-id"] ?? `uid-${uid}`).replace(/[<>]/g, "") };
}

/** A read-only session with one mailbox. */
export class Mailbox {
  private buffer = Buffer.alloc(0);
  private seq = 0;
  /** Counts the chunks received, so a wait that starts after a chunk arrived does not sleep through it. */
  private received = 0;
  private waiting: (() => void) | null = null;
  private failed: Error | null = null;
  private constructor(private socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.received++;
      this.waiting?.();
    });
    socket.on("error", (err) => {
      this.failed = err;
      this.waiting?.();
    });
    socket.on("close", () => {
      this.failed ??= new Error("the mail server closed the connection");
      this.waiting?.();
    });
  }

  /** Signs in and opens the account's all-mail box read-only. The password is sent once, here, and kept nowhere. */
  static async open(creds: { address: string; password: string }, connect: () => net.Socket = () => tls.connect({ host: MAIL.host, port: MAIL.port, servername: MAIL.host })): Promise<Mailbox> {
    const socket = connect();
    socket.setTimeout(MAIL.timeoutMs, () => socket.destroy(new Error("the mail server did not answer in time")));
    const box = new Mailbox(socket);
    await box.greeting();
    const login = await box.command(`LOGIN ${quoted(creds.address)} ${quoted(creds.password)}`);
    if (login.status !== "OK") throw new Error(`Gmail refused the sign-in: ${login.text.replace(/\s+/g, " ").slice(0, 160)}. Use an app password, not your account password.`);
    const list = await box.command('LIST "" "*"');
    const opened = await box.command(`EXAMINE ${quoted(allMailbox(list.replies))}`);
    if (opened.status !== "OK") throw new Error(`could not open the mailbox: ${opened.text.slice(0, 160)}`);
    return box;
  }

  /** Waits for bytes beyond the ones counted in `seen`. */
  private async more(seen: number): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.received === seen) {
      await new Promise<void>((resolve) => (this.waiting = resolve));
      this.waiting = null;
    }
    if (this.failed) throw this.failed;
  }

  private async greeting(): Promise<void> {
    for (let seen = this.received; this.buffer.indexOf("\r\n") < 0; seen = this.received) await this.more(seen);
    const line = this.buffer.subarray(0, this.buffer.indexOf("\r\n")).toString("utf8");
    this.buffer = this.buffer.subarray(this.buffer.indexOf("\r\n") + 2);
    if (!line.startsWith("* OK")) throw new Error("the mail server did not greet as expected");
  }

  private async command(text: string): Promise<NonNullable<Parsed>> {
    const tag = `a${++this.seq}`;
    this.socket.write(`${tag} ${text}\r\n`);
    for (;;) {
      const seen = this.received;
      const parsed = parseAnswer(this.buffer, tag);
      if (parsed) {
        this.buffer = this.buffer.subarray(parsed.consumed);
        return parsed;
      }
      await this.more(seen);
    }
  }

  /** Header fields of every message received on or after the date. */
  async headersSince(since: Date): Promise<MailHeader[]> {
    const found = await this.command(`UID SEARCH SINCE ${imapDate(since)}`);
    const uids = found.replies.flatMap((r) => (r.line.startsWith("* SEARCH") ? r.line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : []));
    const out: MailHeader[] = [];
    for (let at = 0; at < uids.length; at += MAIL.fetchBatch) {
      const res = await this.command(`UID FETCH ${uids.slice(at, at + MAIL.fetchBatch).join(",")} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`);
      for (const r of res.replies) {
        const h = headerFromFetch(r);
        if (h) out.push(h);
      }
    }
    return out;
  }

  /** The readable text of one message, from its first MAIL.maxFetchBytes. PEEK leaves the message unread, as it was. */
  async text(uid: number): Promise<string> {
    const res = await this.command(`UID FETCH ${uid} (BODY.PEEK[]<0.${MAIL.maxFetchBytes}>)`);
    const raw = res.replies.find((r) => r.literals.length)?.literals[0];
    return raw ? messageText(raw) : "";
  }

  async close(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      /* already gone */
    }
    this.socket.destroy();
  }
}
