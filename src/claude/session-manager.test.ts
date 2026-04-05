import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  queryMock,
  getProjectMock,
  getSessionMock,
  getThreadSessionMock,
  upsertSessionMock,
  upsertThreadSessionMock,
  updateSessionStatusMock,
  updateThreadSessionStatusMock,
  setAutoApproveMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getProjectMock: vi.fn(),
  getSessionMock: vi.fn(),
  getThreadSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  upsertThreadSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  updateThreadSessionStatusMock: vi.fn(),
  setAutoApproveMock: vi.fn(),
}));

// Mock all external dependencies before importing session-manager
vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("../db/database.js", () => ({
  upsertSession: upsertSessionMock,
  updateSessionStatus: updateSessionStatusMock,
  getProject: getProjectMock,
  getSession: getSessionMock,
  setAutoApprove: setAutoApproveMock,
  getThreadSession: getThreadSessionMock,
  upsertThreadSession: upsertThreadSessionMock,
  updateThreadSessionStatus: updateThreadSessionStatusMock,
  getGlobalModel: vi.fn(() => null),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => ({ SHOW_COST: true })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("../bot/commands/usage.js", () => ({
  getUsageSummaryLine: vi.fn(async () => "usage"),
  getUsageSnapshot: vi.fn(),
}));

vi.mock("../utils/skills.js", () => ({
  buildGlobalOpsPrompt: vi.fn(() => "Global operating rules:\n- Identify user intent first."),
  buildDefaultOpsHint: vi.fn(() => ""),
  buildLocaleResponseHint: vi.fn(() => "Reply in Korean by default unless the user explicitly asks for another language."),
  buildSkillIntro: vi.fn(() => ""),
}));

vi.mock("./output-formatter.js", () => ({
  createToolApprovalEmbed: vi.fn(() => ({ embed: {}, row: {} })),
  createAskUserQuestionEmbed: vi.fn(() => ({ embed: {}, components: [] })),
  createCompletionControls: vi.fn(() => ([])),
  createResultEmbed: vi.fn(() => ({ title: "done" })),
  createProgressControls: vi.fn(() => ([])),
  formatStreamChunk: vi.fn((text: string) => text),
  splitMessage: vi.fn((text: string) => [text]),
}));

import { sessionManager } from "./session-manager.js";

// Helper to create a mock TextChannel
function mockChannel(id: string) {
  return {
    id,
    send: vi.fn().mockResolvedValue({ edit: vi.fn(), delete: vi.fn() }),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeQueryEvents(sessionId = "sdk-session") {
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: sessionId };
    yield {
      type: "assistant",
      content: [{ text: "ok" }],
      message: { usage: { input_tokens: 123 } },
    };
    yield { result: "Task completed", total_cost_usd: 0, duration_ms: 1 };
  })();
}

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectMock.mockReturnValue({
      channel_id: "project-channel",
      project_path: "/tmp/project",
      guild_id: "guild-1",
      auto_approve: 0,
      model: null,
      skills: null,
      created_at: "now",
    });
    getSessionMock.mockReturnValue(undefined);
    getThreadSessionMock.mockReturnValue(undefined);
    queryMock.mockImplementation(() => {
      const iterator = makeQueryEvents();
      return {
        ...iterator,
        interrupt: vi.fn(),
        [Symbol.asyncIterator]: iterator[Symbol.asyncIterator].bind(iterator),
      };
    });
    (sessionManager as any).sessions.clear();
    (sessionManager as any).messageQueue.clear();
    (sessionManager as any).pendingQueuePrompts.clear();
    (sessionManager as any).forceFreshNext.clear();
    (sessionManager as any).forceUltraFastNext.clear();
  });

  // ─── isActive ───

  describe("isActive", () => {
    it("returns false for unknown channel", () => {
      expect(sessionManager.isActive("unknown-channel")).toBe(false);
    });
  });

  // ─── resolveApproval ───

  describe("resolveApproval", () => {
    it("returns false for unknown requestId", () => {
      expect(sessionManager.resolveApproval("nonexistent", "approve")).toBe(false);
    });
  });

  // ─── resolveQuestion ───

  describe("resolveQuestion", () => {
    it("returns false for unknown requestId", () => {
      expect(sessionManager.resolveQuestion("nonexistent", "answer")).toBe(false);
    });
  });

  // ─── Custom input ───

  describe("custom input", () => {
    it("hasPendingCustomInput returns false initially", () => {
      expect(sessionManager.hasPendingCustomInput("ch-1")).toBe(false);
    });

    it("enableCustomInput sets pending state", () => {
      sessionManager.enableCustomInput("req-1", "ch-1");
      expect(sessionManager.hasPendingCustomInput("ch-1")).toBe(true);
    });

    it("resolveCustomInput returns false when no pending question", () => {
      sessionManager.enableCustomInput("req-no-question", "ch-2");
      // There's a custom input pending but no matching question in pendingQuestions
      expect(sessionManager.resolveCustomInput("ch-2", "hello")).toBe(false);
    });

    it("resolveCustomInput returns false for channel without pending input", () => {
      expect(sessionManager.resolveCustomInput("ch-no-input", "hello")).toBe(false);
    });
  });

  // ─── Message queue ───

  describe("message queue", () => {
    const channelId = "queue-ch";

    it("hasQueue returns false initially", () => {
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("getQueueSize returns 0 initially", () => {
      expect(sessionManager.getQueueSize(channelId)).toBe(0);
    });

    it("isQueueFull returns false when empty", () => {
      expect(sessionManager.isQueueFull(channelId)).toBe(false);
    });

    it("setPendingQueue + hasQueue works", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "test prompt");
      expect(sessionManager.hasQueue(channelId)).toBe(true);
    });

    it("confirmQueue moves pending to queue", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "prompt 1");
      const result = sessionManager.confirmQueue(channelId);
      expect(result).toBe(true);
      expect(sessionManager.getQueueSize(channelId)).toBe(1);
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("confirmQueue returns false when nothing pending", () => {
      expect(sessionManager.confirmQueue("no-pending")).toBe(false);
    });

    it("cancelQueue clears pending", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "to cancel");
      sessionManager.cancelQueue(channelId);
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("isQueueFull returns true after 5 items", () => {
      const ch = "full-queue-ch";
      const channel = mockChannel(ch);
      for (let i = 0; i < 5; i++) {
        sessionManager.setPendingQueue(ch, channel, `msg ${i}`);
        sessionManager.confirmQueue(ch);
      }
      expect(sessionManager.isQueueFull(ch)).toBe(true);
      expect(sessionManager.getQueueSize(ch)).toBe(5);
    });
  });

  // ─── stopSession ───

  describe("stopSession", () => {
    it("returns false for inactive session", async () => {
      expect(await sessionManager.stopSession("no-session")).toBe(false);
    });
  });

  describe("session continuity", () => {
    it("keeps resume session when forceFreshNext is set but a saved thread session exists", async () => {
      const channel = mockChannel("thread-1");
      getThreadSessionMock.mockReturnValue({
        thread_id: "thread-1",
        parent_channel_id: "project-channel",
        session_id: "saved-session-123",
        status: "idle",
        topic: "topic",
        model: null,
        last_activity: "now",
        created_at: "now",
      });
      (sessionManager as any).forceFreshNext.add("thread-1");

      await sessionManager.sendMessage(channel, "continue", {
        scopeId: "thread-1",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArgs = queryMock.mock.calls[0][0];
      expect(queryArgs.options.resume).toBe("saved-session-123");
    });

    it("does not apply ultra-fast query settings when resuming a saved session", async () => {
      const channel = mockChannel("thread-3");
      getThreadSessionMock.mockReturnValue({
        thread_id: "thread-3",
        parent_channel_id: "project-channel",
        session_id: "saved-session-456",
        status: "idle",
        topic: "topic",
        model: null,
        last_activity: "now",
        created_at: "now",
      });
      (sessionManager as any).forceUltraFastNext.add("thread-3");

      await sessionManager.sendMessage(channel, "continue", {
        scopeId: "thread-3",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArgs = queryMock.mock.calls[0][0];
      expect(queryArgs.options.resume).toBe("saved-session-456");
      expect(queryArgs.options.maxTurns).toBeUndefined();
      expect(queryArgs.options.model).toBeUndefined();
    });

    it("still starts fresh when no saved session exists and forceFreshNext is set", async () => {
      const channel = mockChannel("thread-2");
      (sessionManager as any).forceFreshNext.add("thread-2");

      await sessionManager.sendMessage(channel, "continue", {
        scopeId: "thread-2",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArgs = queryMock.mock.calls[0][0];
      expect(queryArgs.options.resume).toBeUndefined();
    });

    it("keeps ultra-fast retry behavior when no saved session exists", async () => {
      const channel = mockChannel("thread-4");
      (sessionManager as any).forceUltraFastNext.add("thread-4");

      await sessionManager.sendMessage(channel, "continue", {
        scopeId: "thread-4",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArgs = queryMock.mock.calls[0][0];
      expect(queryArgs.options.resume).toBeUndefined();
      expect(queryArgs.options.maxTurns).toBe(1);
      expect(queryArgs.options.model).toBe("haiku");
    });

    it("keeps resume continuity for queued follow-up in same thread", async () => {
      const channel = mockChannel("thread-queue");
      getThreadSessionMock.mockReturnValue({
        thread_id: "thread-queue",
        parent_channel_id: "project-channel",
        session_id: "saved-session-queue",
        status: "idle",
        topic: "topic",
        model: null,
        last_activity: "now",
        created_at: "now",
      });

      (sessionManager as any).forceFreshNext.add("thread-queue");
      sessionManager.enqueueMessage("thread-queue", channel, "follow-up queued");

      await sessionManager.sendMessage(channel, "start", {
        scopeId: "thread-queue",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      const secondQueryArgs = queryMock.mock.calls[1][0];
      expect(secondQueryArgs.options.resume).toBe("saved-session-queue");
    });

    it("always prepends a locale response hint to the outgoing prompt", async () => {
      const channel = mockChannel("thread-locale");

      await sessionManager.sendMessage(channel, "안녕", {
        scopeId: "thread-locale",
        projectChannelId: "project-channel",
        topic: "topic",
      });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const queryArgs = queryMock.mock.calls[0][0];
    expect(queryArgs.prompt).toContain("Global operating rules:");
    expect(queryArgs.prompt).toContain("Reply in Korean by default unless the user explicitly asks for another language.");
    expect(queryArgs.options.settingSources).toEqual(["user", "project", "local"]);
    expect(queryArgs.prompt).toContain("안녕");
  });

    it("announces Codex auto decisions and includes them in the completion summary", async () => {
      const channel = mockChannel("thread-codex-auto");
      queryMock.mockImplementationOnce(() => {
        const iterator = (async function* () {
          yield { type: "system", subtype: "init", session_id: "sdk-session" };
          yield {
            type: "assistant",
            content: [{
              text: [
                "[Codex Auto Decision]",
                "Path: rescue-background",
                "Reason: no active resumable Codex task exists",
                "Model: gpt-5.4",
                "Next: poll status and fetch result automatically",
              ].join("\n"),
            }],
            message: { usage: { input_tokens: 222 } },
          };
          yield { result: "Task completed", total_cost_usd: 0, duration_ms: 1 };
        })();
        return {
          ...iterator,
          interrupt: vi.fn(),
          [Symbol.asyncIterator]: iterator[Symbol.asyncIterator].bind(iterator),
        };
      });

      await sessionManager.sendMessage(channel, "codex continue", {
        scopeId: "thread-codex-auto",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      const payloadTexts = (channel.send.mock.calls as unknown[][]).map((call: unknown[]) => {
        const payload = call[0];
        if (typeof payload === "string") return payload;
        if (typeof payload === "object" && payload !== null && "content" in payload) {
          const content = (payload as { content?: unknown }).content;
          return typeof content === "string" ? content : "";
        }
        return "";
      });

      expect(payloadTexts.some((text) => text.includes("Codex Auto Decision"))).toBe(true);
      expect(payloadTexts.some((text) => text.includes("Codex auto decision : rescue-background (gpt-5.4)"))).toBe(true);
      expect(payloadTexts.some((text) => text.includes("Decision reason : no active resumable Codex task exists"))).toBe(true);
    });

    it("shows human-readable current progress details for system progress events", async () => {
      const progressHandle = { edit: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
      const channel = {
        id: "thread-progress",
        send: vi.fn().mockResolvedValue(progressHandle),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      } as any;
      queryMock.mockImplementationOnce(() => {
        const iterator = (async function* () {
          yield { type: "system", subtype: "init", session_id: "sdk-session" };
          await new Promise((resolve) => setTimeout(resolve, 1300));
          yield { type: "system", subtype: "task_progress", message: "Analyzing logs" };
          await new Promise((resolve) => setTimeout(resolve, 1300));
          yield { result: "Task completed", total_cost_usd: 0, duration_ms: 1 };
        })();
        return {
          ...iterator,
          interrupt: vi.fn(),
          [Symbol.asyncIterator]: iterator[Symbol.asyncIterator].bind(iterator),
        };
      });

      await sessionManager.sendMessage(channel, "check progress", {
        scopeId: "thread-progress",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      const progressPayloads = [
        ...(channel.send.mock.calls as unknown[][]).map((call: unknown[]) => call[0]),
        ...(progressHandle.edit.mock.calls as unknown[][]).map((call: unknown[]) => call[0]),
      ];
      const editedBodies = progressPayloads.map((payload) => {
        if (typeof payload === "string") return payload;
        if (typeof payload === "object" && payload !== null && "content" in payload) {
          const content = (payload as { content?: unknown }).content;
          return typeof content === "string" ? content : "";
        }
        return "";
      });
      expect(editedBodies.some((body) => body.includes("check progress") || body.includes("Session") || body.includes("Current"))).toBe(true);
    });

    it("hides duplicate generic progress lines when a more specific step exists", async () => {
      getProjectMock.mockReturnValue({
        channel_id: "project-channel",
        project_path: "/tmp/project",
        guild_id: "guild-1",
        auto_approve: 1,
        model: null,
        skills: null,
        created_at: "now",
      });

      const progressHandle = { edit: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
      const channel = {
        id: "thread-dedupe",
        send: vi.fn().mockResolvedValue(progressHandle),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      } as any;

      queryMock.mockImplementationOnce((args: any) => {
        const iterator = (async function* () {
          yield { type: "system", subtype: "init", session_id: "sdk-session" };
          await args.options.canUseTool("Edit", {
            file_path: "/Users/jiho/git/auto-trading/scripts/tv_deep_bt_playwright.py",
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          yield { type: "system", subtype: "task_started" };
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await args.options.canUseTool("Bash", {
            command: "tail -5 /tmp/sweep_v24_sol.log 2>&1",
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          yield { result: "Task completed", total_cost_usd: 0, duration_ms: 1 };
        })();

        return {
          ...iterator,
          interrupt: vi.fn(),
          [Symbol.asyncIterator]: iterator[Symbol.asyncIterator].bind(iterator),
        };
      });

      await sessionManager.sendMessage(channel, "진행중?", {
        scopeId: "thread-dedupe",
        projectChannelId: "project-channel",
        topic: "topic",
      });

      const progressPayloads = [
        ...(channel.send.mock.calls as unknown[][]).map((call: unknown[]) => call[0]),
        ...(progressHandle.edit.mock.calls as unknown[][]).map((call: unknown[]) => call[0]),
      ];
      const progressBodies = progressPayloads.map((payload) => {
        if (typeof payload === "string") return payload;
        if (typeof payload === "object" && payload !== null && "content" in payload) {
          const content = (payload as { content?: unknown }).content;
          return typeof content === "string" ? content : "";
        }
        return "";
      });
      const combined = progressBodies.join("\n");

      expect(combined).toContain("Editing /Users/jiho/git/auto-trading/scripts/tv_deep_bt_playwright.py");
      expect(combined).toContain("Running command: tail -5 /tmp/sweep_v24_sol.log 2>&1");
      expect(combined).not.toContain("Editing file `tv_deep_bt_playwright.py`");
      expect(combined).not.toContain("Status: Running command");
      expect(combined).not.toContain("system:task_started");
    });
  });
});
