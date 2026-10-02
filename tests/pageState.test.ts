import { describe, expect, it } from "vitest";
import { JEV } from "../src/config.js";
import { decidePageState } from "../src/forms/pageState.js";
import type { JevClient } from "../src/jev/client.js";

describe("decidePageState", () => {
  it("shows JEV the start and the end of a long page, since what a click produced is at the end", async () => {
    let seen = "";
    const jev = {
      decide: async (state: { text: string }) => {
        seen = state.text;
        return {
          state: { type: "choice", choice: "application_form", confidence: 0.9, probabilities: {} },
          has_apply_button: { type: "noul", noul: 0 },
          has_more_pages: { type: "noul", noul: 0 },
          requires_references: { type: "noul", noul: 0 },
          requires_cover_letter: { type: "noul", noul: 0 },
        };
      },
    } as unknown as JevClient;
    const page = `About the role. ${"word ".repeat(JEV.maxPageTextChars)}A verification code was sent to you.`;
    const res = await decidePageState(jev, page, "https://x/1");
    expect(res.state).toBe("application_form");
    expect(seen.startsWith("About the role.")).toBe(true);
    expect(seen.endsWith("A verification code was sent to you.")).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(JEV.maxPageTextChars + 10);
  });
});
