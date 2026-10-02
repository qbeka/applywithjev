import { describe, expect, it } from "vitest";
import { codeArrived, companyWords, InboxFile, isCodeMessage, latestReply, matchJob, replyQuestion, sortMail, type AppliedJob } from "../src/mail/inbox.js";
import type { MailHeader } from "../src/mail/imap.js";
import type { JevClient } from "../src/jev/client.js";

const job = (id: string, company: string, title = "Software Engineer Intern", appliedAt: string | null = "2026-10-02T17:00:00Z"): AppliedJob => ({ id, company, title, appliedAt });
const mail = (subject: string, address: string, name = "", date = "2026-10-02T17:37:00Z", uid = 1): MailHeader => ({ uid, from: { name, address, domain: address.split("@")[1] ?? "" }, subject, date, messageId: `${uid}@x` });
const jobs = [job("acme", "Acme"), job("haven", "Haven Studios"), job("sim", "Sim"), job("pin-z", "Pinterest", "Software Engineering Intern 2027 (Zurich)"), job("pin-d", "Pinterest", "Software Engineering Intern 2027 (Dublin)")];
const jevSaying = (kind: string) => ({ decide: async () => ({ kind: { type: "choice", choice: kind, confidence: 0.95, probabilities: {} } }) }) as unknown as JevClient;

describe("which job a message is about", () => {
  it("matches a company named in the subject when the sender is a board's mail system", () => {
    expect(matchJob(mail("Thank you for applying to Acme", "no-reply@us.greenhouse-mail.io"), jobs)?.id).toBe("acme");
    expect(matchJob(mail("Thanks for applying to Acme!", "no-reply@ashbyhq.com"), jobs)?.id).toBe("acme");
  });
  it("matches a company's own mail, and a company whose mail comes from its parent", () => {
    expect(matchJob(mail("An update on your candidacy with Acme", "talent@acme.com"), jobs)?.id).toBe("acme");
    expect(matchJob(mail("Thank you for applying to Haven Interactive Studios", "no-reply@sony.com"), jobs)?.id).toBe("haven");
  });
  it("does not take a common word in unrelated mail for a company", () => {
    expect(matchJob(mail("Your SIM card has shipped", "orders@telco.example"), jobs)).toBeNull();
    expect(matchJob(mail("Acmefest tickets on sale", "news@tickets.example"), jobs)).toBeNull();
  });
  it("picks the role the subject names when one company has several", () => {
    expect(matchJob(mail("Your application for Software Engineering Intern 2027 (Zurich) at Pinterest", "no-reply@us.greenhouse-mail.io"), jobs)?.id).toBe("pin-z");
    expect(matchJob(mail("Your application for Software Engineering Intern 2027 (Dublin) at Pinterest", "no-reply@us.greenhouse-mail.io"), jobs)?.id).toBe("pin-d");
  });
  it("ignores mail from before the application", () => {
    expect(matchJob(mail("Thank you for applying to Acme", "no-reply@us.greenhouse-mail.io", "", "2026-09-01T00:00:00Z"), jobs)).toBeNull();
  });
  it("names a company by its own words", () => {
    expect(companyWords("Slice (slicelife.com)")).toEqual(["slice"]);
    expect(companyWords("Freedom Technology Solutions Group")).toEqual(["freedom"]);
    expect(companyWords("The Group")).toEqual(["the", "group"]);
  });
});

describe("a code message", () => {
  it("is told by its subject", () => {
    expect(isCodeMessage("Security code for your application to Parallel Systems")).toBe(true);
    expect(isCodeMessage("Your verification code")).toBe(true);
    expect(isCodeMessage("Thank you for applying to Acme")).toBe(false);
  });
  it("is noted without being opened, shown to JEV, or kept by its subject", async () => {
    let read = 0;
    const never = { decide: async () => { throw new Error("JEV must not see a code message"); } } as unknown as JevClient;
    const { news, inbox } = await sortMail([mail("Security code for your application to Acme", "no-reply@us.greenhouse-mail.io")], jobs, InboxFile.parse({}), async () => { read++; return "the code"; }, never);
    expect(read).toBe(0);
    expect(news[0]?.seen).toMatchObject({ jobId: "acme", kind: "code", subject: "" });
    expect(JSON.stringify(inbox)).not.toContain("the code");
    expect(codeArrived(inbox, "acme")?.at).toBe("2026-10-02T17:37:00Z");
    expect(codeArrived(inbox, "acme", "2026-10-03T00:00:00Z")).toBeNull();
  });
});

describe("sortMail", () => {
  it("judges each new message once and skips mail about nothing applied to", async () => {
    const headers = [mail("Thank you for applying to Acme", "no-reply@us.greenhouse-mail.io", "", "2026-10-02T17:37:00Z", 1), mail("Lunch on Friday?", "friend@example.com", "", "2026-10-02T18:00:00Z", 2)];
    let read = 0;
    const first = await sortMail(headers, jobs, InboxFile.parse({}), async () => { read++; return "We received your application."; }, jevSaying("received"));
    expect(read).toBe(1);
    expect(first.news.map((n) => [n.job.id, n.seen.kind])).toEqual([["acme", "received"]]);
    const again = await sortMail(headers, jobs, first.inbox, async () => { read++; return ""; }, jevSaying("received"));
    expect(read).toBe(1);
    expect(again.news).toEqual([]);
  });
  it("remembers mail JEV calls unrelated, but does not report it", async () => {
    const { news, inbox } = await sortMail([mail("Jobs you may like at Acme", "alerts@acme.com")], jobs, InboxFile.parse({}), async () => "New openings.", jevSaying("unrelated"));
    expect(news).toEqual([]);
    expect(Object.values(inbox.seen)[0]?.kind).toBe("unrelated");
    expect(latestReply(inbox, "acme")).toBeNull();
  });
  it("asks with a definition for every outcome", () => {
    expect(Object.keys(replyQuestion().criteria)).toEqual(["received", "rejected", "interview", "assessment", "offer", "question", "unrelated"]);
  });
});

describe("what the record shows", () => {
  const seen = (kind: string, at: string) => ({ jobId: "acme", kind, at, from: "Acme", subject: "s" });
  it("is the latest reply that says more than received", () => {
    const inbox = InboxFile.parse({ seen: { a: seen("received", "2026-10-02T00:00:00Z"), b: seen("assessment", "2026-10-03T00:00:00Z"), c: seen("received", "2026-10-04T00:00:00Z"), d: seen("code", "2026-10-05T00:00:00Z") } });
    expect(latestReply(inbox, "acme")?.kind).toBe("assessment");
  });
  it("is received when that is all there is", () => {
    expect(latestReply(InboxFile.parse({ seen: { a: seen("received", "2026-10-02T00:00:00Z") } }), "acme")?.kind).toBe("received");
  });
});
