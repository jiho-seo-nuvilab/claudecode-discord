import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MODEL,
  buildCodexAutoContinuePrompt,
  buildCodexCancelCommand,
  buildCodexRescueCommand,
  buildCodexResultCommand,
  buildCodexReviewCommand,
  buildCodexStatusCommand,
  extractCodexAutoDecision,
} from "./codex.js";

describe("codex command helpers", () => {
  it("pins normal review to the default Codex model", () => {
    expect(buildCodexReviewCommand("normal")).toBe(`/codex:review --background --model ${DEFAULT_CODEX_MODEL}`);
  });

  it("pins adversarial review to the default Codex model and preserves options", () => {
    expect(buildCodexReviewCommand("adversarial", "main", "focus auth rollback")).toBe(
      `/codex:adversarial-review --background --model ${DEFAULT_CODEX_MODEL} --base main focus auth rollback`,
    );
  });

  it("allows model override for rescue and review", () => {
    expect(buildCodexReviewCommand("normal", undefined, undefined, "gpt-5.4-mini")).toBe(
      "/codex:review --background --model gpt-5.4-mini",
    );
    expect(buildCodexRescueCommand("Investigate failing CI", "gpt-5.4-mini")).toBe(
      "/codex:rescue --model gpt-5.4-mini Investigate failing CI",
    );
  });

  it("pins rescue commands to the default Codex model", () => {
    expect(buildCodexRescueCommand("Investigate failing CI")).toBe(
      `/codex:rescue --model ${DEFAULT_CODEX_MODEL} Investigate failing CI`,
    );
  });

  it("keeps passthrough commands unchanged", () => {
    expect(buildCodexStatusCommand()).toBe("/codex:status");
    expect(buildCodexResultCommand()).toBe("/codex:result");
    expect(buildCodexCancelCommand()).toBe("/codex:cancel");
  });

  it("builds an automatic Codex continue prompt with checkpoint context", () => {
    const prompt = buildCodexAutoContinuePrompt({
      description: "Apply review fixes",
      improvements: ["tighten auth", "recheck rollback"],
    });
    expect(prompt).toContain("[Codex Auto Continue]");
    expect(prompt).toContain("[Codex Auto Decision]");
    expect(prompt).toContain("status/result/resume/rescue");
    expect(prompt).toContain("/codex:rescue --background");
    expect(prompt).toContain("codex resume <id>");
    expect(prompt).toContain("Apply review fixes");
    expect(prompt).toContain("tighten auth");
    expect(prompt).toContain(DEFAULT_CODEX_MODEL);
  });

  it("extracts Codex auto decision blocks", () => {
    const parsed = extractCodexAutoDecision([
      "prefix",
      "[Codex Auto Decision]",
      "Path: resume",
      "Reason: existing session is still relevant",
      "Model: gpt-5.4",
      "Next: continue from saved result",
    ].join("\n"));

    expect(parsed).toEqual({
      path: "resume",
      reason: "existing session is still relevant",
      model: "gpt-5.4",
      next: "continue from saved result",
    });
  });
});
