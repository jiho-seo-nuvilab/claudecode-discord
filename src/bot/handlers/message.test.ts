import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, getThreadSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getThreadSessionMock: vi.fn(),
}));

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getLatestThreadSession: vi.fn(),
  getSession: getSessionMock,
  getThreadSession: getThreadSessionMock,
}));

vi.mock("../../security/guard.js", () => ({
  isAllowedUser: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("../../claude/session-manager.js", () => ({
  sessionManager: {},
}));

vi.mock("../thread-router.js", () => ({
  setPendingRootPrompt: vi.fn(),
}));

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

import { hasStoredSessionContext, shouldPreferFreshSession, shouldUseUltraFastMode } from "./message.js";

describe("message fast-path heuristics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("detects stored session context for root channels", () => {
    getSessionMock.mockReturnValue({ session_id: "root-session-1" });

    expect(hasStoredSessionContext(false, "channel-1", "channel-1")).toBe(true);
  });

  it("detects stored session context for threads", () => {
    getThreadSessionMock.mockReturnValue({ session_id: "thread-session-1" });

    expect(hasStoredSessionContext(true, "thread-1", "channel-1")).toBe(true);
  });

  it("returns false when no stored session exists", () => {
    getSessionMock.mockReturnValue(undefined);

    expect(hasStoredSessionContext(false, "channel-1", "channel-1")).toBe(false);
  });
});
