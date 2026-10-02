import { describe, expect, it } from "vitest";
import { allMailbox, decodeHeader, headerFromFetch, imapDate, messageText, parseAnswer, parseHeaders, parseSender, quoted } from "../src/mail/imap.js";

const crlf = (s: string) => s.replace(/\n/g, "\r\n");

describe("parseAnswer", () => {
  it("waits for the tagged line and returns the untagged replies before it", () => {
    const whole = Buffer.from(crlf("* SEARCH 4 9 12\na3 OK SEARCH completed\n"));
    expect(parseAnswer(whole.subarray(0, 10), "a3")).toBeNull();
    const done = parseAnswer(whole, "a3");
    expect(done?.status).toBe("OK");
    expect(done?.replies.map((r) => r.line)).toEqual(["* SEARCH 4 9 12"]);
    expect(done?.consumed).toBe(whole.length);
  });
  it("lifts literals out of a reply, and waits until a literal has fully arrived", () => {
    const header = "Subject: Hi\r\nFrom: a@b.co\r\n\r\n";
    const whole = Buffer.from(`* 1 FETCH (UID 7 BODY[HEADER.FIELDS (FROM SUBJECT)] {${header.length}}\r\n${header})\r\na4 OK done\r\n`);
    expect(parseAnswer(whole.subarray(0, whole.length - 30), "a4")).toBeNull();
    const done = parseAnswer(whole, "a4");
    expect(done?.replies[0]?.line).toBe("* 1 FETCH (UID 7 BODY[HEADER.FIELDS (FROM SUBJECT)] {})");
    expect(done?.replies[0]?.literals[0]?.toString()).toBe(header);
  });
  it("is not fooled by a line inside a literal that looks like the tagged line", () => {
    const body = "a5 OK this is message text\r\n";
    const whole = Buffer.from(`* 1 FETCH (BODY[] {${body.length}}\r\n${body})\r\na5 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    const done = parseAnswer(whole, "a5");
    expect(done?.status).toBe("NO");
    expect(done?.text).toContain("Invalid credentials");
    expect(done?.replies).toHaveLength(1);
  });
});

describe("small IMAP pieces", () => {
  it("quotes a string and writes a date the way the server wants", () => {
    expect(quoted('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(imapDate(new Date("2026-10-02T15:00:00Z"))).toBe("2-Oct-2026");
  });
  it("finds the all-mail box whatever it is called, and falls back to the inbox", () => {
    const list = (lines: string[]) => lines.map((line) => ({ line, literals: [] }));
    expect(allMailbox(list(['* LIST (\\HasNoChildren) "/" "INBOX"', '* LIST (\\All \\HasNoChildren) "/" "[Gmail]/Alle Nachrichten"']))).toBe("[Gmail]/Alle Nachrichten");
    expect(allMailbox(list(['* LIST (\\HasNoChildren) "/" "INBOX"']))).toBe("INBOX");
  });
});

describe("headers", () => {
  it("joins folded lines and decodes encoded words", () => {
    const h = parseHeaders(crlf("Subject: =?UTF-8?B?VGhhbmtzIGZvciBhcHBseWluZyB0byBBY23DqQ==?=\n =?UTF-8?Q?_and_more?=\nFrom: \"Acme Recruiting\" <no-reply@us.greenhouse-mail.io>\nDate: Fri, 02 Oct 2026 17:37:21 +0000\n"));
    expect(decodeHeader(h.subject ?? "")).toBe("Thanks for applying to Acmé and more");
    expect(parseSender(h.from ?? "")).toEqual({ name: "Acme Recruiting", address: "no-reply@us.greenhouse-mail.io", domain: "us.greenhouse-mail.io" });
    expect(parseSender("no-reply@seatgeek.com")).toEqual({ name: "", address: "no-reply@seatgeek.com", domain: "seatgeek.com" });
  });
  it("reads one message's header from a FETCH reply", () => {
    const block = crlf("From: Acme <jobs@acme.com>\nSubject: Thank you for applying to Acme\nDate: Fri, 02 Oct 2026 17:37:21 +0000\nMessage-ID: <abc@mail.acme.com>\n\n");
    const h = headerFromFetch({ line: "* 3 FETCH (UID 41 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {})", literals: [Buffer.from(block)] });
    expect(h).toEqual({ uid: 41, from: { name: "Acme", address: "jobs@acme.com", domain: "acme.com" }, subject: "Thank you for applying to Acme", date: "2026-10-02T17:37:21.000Z", messageId: "abc@mail.acme.com" });
    expect(headerFromFetch({ line: "* 3 FETCH (FLAGS ())", literals: [] })).toBeNull();
  });
});

describe("messageText", () => {
  it("reads a plain message, quoted-printable or base64", () => {
    expect(messageText(crlf("Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nThanks for applying to Acm=C3=A9. We will be in =\ntouch.\n"))).toBe("Thanks for applying to Acmé. We will be in touch.");
    expect(messageText(crlf(`Content-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: base64\n\n${Buffer.from("We would like to invite you to an interview.").toString("base64")}\n`))).toBe("We would like to invite you to an interview.");
  });
  it("prefers the plain part of a multipart message and turns an HTML-only one into text", () => {
    const both = crlf('Content-Type: multipart/alternative; boundary="b1"\n\n--b1\nContent-Type: text/plain\n\nPlain words.\n--b1\nContent-Type: text/html\n\n<p>HTML words.</p>\n--b1--\n');
    expect(messageText(both)).toBe("Plain words.");
    const html = crlf('Content-Type: multipart/mixed; boundary=b2\n\n--b2\nContent-Type: text/html; charset=utf-8\n\n<html><body><p>Unfortunately we will not be moving forward.</p><p>Thank you.</p></body></html>\n--b2\nContent-Type: application/pdf\nContent-Transfer-Encoding: base64\n\nJVBERi0=\n--b2--\n');
    expect(messageText(html)).toBe("Unfortunately we will not be moving forward.\nThank you.");
  });
  it("reads a message that was cut short, as far as it goes", () => {
    const cut = crlf('Content-Type: multipart/alternative; boundary="b3"\n\n--b3\nContent-Type: text/plain\n\nThe first part is all that was fetch');
    expect(messageText(cut)).toBe("The first part is all that was fetch");
  });
});

describe("Mailbox, against a local server that speaks the same protocol", () => {
  it("signs in, opens all mail read-only, lists headers and reads one message without changing anything", async () => {
    const net = await import("node:net");
    const { Mailbox } = await import("../src/mail/imap.js");
    const header = "From: Acme <jobs@acme.com>\r\nSubject: Thank you for applying to Acme\r\nDate: Fri, 02 Oct 2026 17:37:21 +0000\r\nMessage-ID: <m1@acme.com>\r\n\r\n";
    const message = "Content-Type: text/plain; charset=utf-8\r\n\r\nWe received your application.\r\n";
    const commands: string[] = [];
    const server = net.createServer((sock) => {
      sock.write("* OK ready\r\n");
      let pending = "";
      sock.on("data", (chunk) => {
        pending += chunk.toString();
        let eol: number;
        while ((eol = pending.indexOf("\r\n")) >= 0) {
          const line = pending.slice(0, eol);
          pending = pending.slice(eol + 2);
          const [tag, ...rest] = line.split(" ");
          const cmd = rest.join(" ");
          commands.push(cmd.startsWith("LOGIN") ? "LOGIN" : cmd);
          if (cmd.startsWith("LOGIN")) sock.write(cmd.includes('"right password"') ? `${tag} OK signed in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          else if (cmd.startsWith("LIST")) sock.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\All) "/" "[Gmail]/All Mail"\r\n${tag} OK\r\n`);
          else if (cmd.startsWith("EXAMINE")) sock.write(`* 1 EXISTS\r\n${tag} OK [READ-ONLY] opened\r\n`);
          else if (cmd.startsWith("UID SEARCH")) sock.write(`* SEARCH 41\r\n${tag} OK\r\n`);
          else if (cmd.includes("HEADER.FIELDS")) sock.write(`* 1 FETCH (UID 41 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${header.length}}\r\n${header})\r\n${tag} OK\r\n`);
          else if (cmd.includes("BODY.PEEK[]")) sock.write(`* 1 FETCH (UID 41 BODY[]<0> {${message.length}}\r\n${message})\r\n${tag} OK\r\n`);
          else if (cmd === "LOGOUT") sock.end(`* BYE\r\n${tag} OK\r\n`);
          else sock.write(`${tag} BAD unknown\r\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const connect = () => net.connect({ host: "127.0.0.1", port });
    try {
      await expect(Mailbox.open({ address: "someone@example.com", password: "wrong" }, connect)).rejects.toThrow(/refused the sign-in/);
      const box = await Mailbox.open({ address: "someone@example.com", password: "right password" }, connect);
      const headers = await box.headersSince(new Date("2026-10-01T00:00:00Z"));
      expect(headers).toHaveLength(1);
      expect(headers[0]).toMatchObject({ uid: 41, subject: "Thank you for applying to Acme", messageId: "m1@acme.com" });
      expect(await box.text(41)).toBe("We received your application.");
      await box.close();
      const afterSignIn = commands.slice(commands.lastIndexOf("LOGIN") + 1);
      expect(afterSignIn[1]).toBe('EXAMINE "[Gmail]/All Mail"');
      // Nothing that changes mail: no STORE, COPY, MOVE, EXPUNGE, APPEND or SELECT, and bodies are only peeked at.
      expect(afterSignIn.join("\n")).not.toMatch(/STORE|COPY|MOVE|EXPUNGE|APPEND|\bSELECT\b|BODY\[\]/);
    } finally {
      server.close();
    }
  });
});
