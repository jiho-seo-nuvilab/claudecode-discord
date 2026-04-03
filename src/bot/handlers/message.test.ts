import { describe, expect, it } from "vitest";
import { shouldPreferFreshSession, shouldUseUltraFastMode } from "./message.js";

describe("message fast-path heuristics", () => {
  it("uses ultra-fast mode only for trivial greetings", () => {
    expect(shouldUseUltraFastMode("하이", false)).toBe(true);
    expect(shouldUseUltraFastMode("안녕?", false)).toBe(true);
    expect(shouldUseUltraFastMode("ping", false)).toBe(true);
  });

  it("does not use ultra-fast mode for normal short requests", () => {
    expect(shouldUseUltraFastMode("스킬크리에이터 스킬로 만들어줘", false)).toBe(false);
    expect(shouldUseUltraFastMode("프로젝트", false)).toBe(false);
    expect(shouldUseUltraFastMode("README 보여줘", false)).toBe(false);
  });

  it("still prefers fresh session for short non-trivial requests", () => {
    expect(shouldPreferFreshSession("프로젝트", false)).toBe(true);
    expect(shouldPreferFreshSession("README 보여줘", false)).toBe(true);
  });

  it("disables fast-paths when attachments exist", () => {
    expect(shouldPreferFreshSession("하이", true)).toBe(false);
    expect(shouldUseUltraFastMode("하이", true)).toBe(false);
  });
});
