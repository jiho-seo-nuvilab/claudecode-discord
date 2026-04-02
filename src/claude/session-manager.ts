import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  setAutoApprove,
  getThreadSession,
  upsertThreadSession,
  updateThreadSessionStatus,
  getGlobalModel,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import { L } from "../utils/i18n.js";
import { getVersionInfo } from "../utils/version.js";
import {
  createToolApprovalEmbed,
  createAskUserQuestionEmbed,
  createResultEmbed,
  splitMessage,
  type AskQuestionData,
} from "./output-formatter.js";
import { getUsageSummaryLine, getUsageSnapshot } from "../bot/commands/usage.js";
import { buildDefaultOpsHint, buildSkillIntro } from "../utils/skills.js";

interface ActiveSession {
  queryInstance: Query;
  scopeId: string;
  projectChannelId: string;
  sessionId: string | null;
  dbId: string;
  topic: string | null;
}

type SessionStatus = "online" | "offline" | "waiting" | "idle";

const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
    scopeId: string;
  }
>();

const pendingQuestions = new Map<
  string,
  {
    resolve: (answer: string | null) => void;
    scopeId: string;
  }
>();

const pendingCustomInputs = new Map<string, { requestId: string }>();

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private static readonly MAX_QUEUE_SIZE = 5;
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();

  private setStoredStatus(scopeId: string, projectChannelId: string, status: SessionStatus): void {
    if (scopeId === projectChannelId) {
      updateSessionStatus(projectChannelId, status);
    } else {
      updateThreadSessionStatus(scopeId, status);
    }
  }

  async sendMessage(
    channel: TextChannel,
    prompt: string,
    options?: { scopeId?: string; projectChannelId?: string; topic?: string | null },
  ): Promise<void> {
    const scopeId = options?.scopeId ?? channel.id;
    const projectChannelId = options?.projectChannelId ?? channel.id;
    const project = getProject(projectChannelId);
    if (!project) return;

    const existingSession = this.sessions.get(scopeId);
    const dbSession = !existingSession
      ? (scopeId === projectChannelId ? getSession(projectChannelId) : getThreadSession(scopeId))
      : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    const resumeSessionId = existingSession?.sessionId ?? dbSession?.session_id ?? undefined;
    const topic = options?.topic ?? existingSession?.topic ?? dbSession?.topic ?? null;
    const selectedSkills = project.skills
      ? project.skills.split(",").map((skill) => skill.trim()).filter(Boolean)
      : [];

    if (scopeId === projectChannelId) {
      upsertSession(dbId, projectChannelId, resumeSessionId ?? null, "online");
    } else {
      upsertThreadSession(scopeId, projectChannelId, resumeSessionId ?? null, "online", topic);
    }

    let responseBuffer = "";
    let lastEditTime = 0;
    let currentMessage: { edit: (v: any) => Promise<any> } | null = null;
    const EDIT_INTERVAL = 1500;

    const startTime = Date.now();
    let lastActivity = L("Thinking...", "생각 중...");
    let toolUseCount = 0;
    let hasTextOutput = false;
    let hasResult = false;
    let maxInputTokens = 0;

    const heartbeatInterval = setInterval(async () => {
      if (hasTextOutput) return;
      try {
        await channel.sendTyping();
      } catch (e) {
        console.warn(`[heartbeat] Failed to send typing for ${scopeId}:`, e instanceof Error ? e.message : e);
      }
    }, 15_000);

    try {
      const promptWithContext = !resumeSessionId && scopeId !== projectChannelId
        ? [
            buildSkillIntro(selectedSkills),
            buildDefaultOpsHint(),
            prompt,
          ].filter(Boolean).join("\n\n")
        : prompt;

      const globalModel = getGlobalModel();
      const effectiveModel = dbSession?.model ?? project.model ?? globalModel ?? undefined;

      const queryInstance = query({
        prompt: promptWithContext,
        options: {
          cwd: project.project_path,
          permissionMode: "default",
          ...(effectiveModel ? { model: effectiveModel } : {}),
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: undefined,
            PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          },
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            toolUseCount++;

            const toolLabels: Record<string, string> = {
              Read: L("Reading files", "파일 읽는 중"),
              Glob: L("Searching files", "파일 검색 중"),
              Grep: L("Searching code", "코드 검색 중"),
              Write: L("Writing file", "파일 작성 중"),
              Edit: L("Editing file", "파일 편집 중"),
              Bash: L("Running command", "명령어 실행 중"),
              WebSearch: L("Searching web", "웹 검색 중"),
              WebFetch: L("Fetching URL", "URL 가져오는 중"),
              TodoWrite: L("Updating tasks", "작업 업데이트 중"),
            };
            const filePath = typeof input.file_path === "string"
              ? ` \`${(input.file_path as string).split(/[\\/]/).pop()}\``
              : "";
            lastActivity = `${toolLabels[toolName] ?? `Using ${toolName}`}${filePath}`;

            if (!hasTextOutput) {
              try {
                await channel.sendTyping();
              } catch (e) {
                console.warn(`[tool-status] Failed to send typing for ${scopeId}:`, e instanceof Error ? e.message : e);
              }
            }

            if (toolName === "AskUserQuestion") {
              const questions = (input.questions as AskQuestionData[]) ?? [];
              if (questions.length === 0) {
                return { behavior: "allow" as const, updatedInput: input };
              }

              const answers: Record<string, string> = {};
              for (let qi = 0; qi < questions.length; qi++) {
                const q = questions[qi];
                const qRequestId = randomUUID();
                const { embed, components } = createAskUserQuestionEmbed(q, qRequestId, qi, questions.length);

                this.setStoredStatus(scopeId, projectChannelId, "waiting");
                await channel.send({ embeds: [embed], components });

                const answer = await new Promise<string | null>((resolve) => {
                  const timeout = setTimeout(() => {
                    pendingQuestions.delete(qRequestId);
                    const ci = pendingCustomInputs.get(scopeId);
                    if (ci?.requestId === qRequestId) pendingCustomInputs.delete(scopeId);
                    resolve(null);
                  }, 5 * 60 * 1000);

                  pendingQuestions.set(qRequestId, {
                    resolve: (ans) => {
                      clearTimeout(timeout);
                      pendingQuestions.delete(qRequestId);
                      resolve(ans);
                    },
                    scopeId,
                  });
                });

                if (answer === null) {
                  this.setStoredStatus(scopeId, projectChannelId, "online");
                  return {
                    behavior: "deny" as const,
                    message: L("Question timed out", "질문 시간 초과"),
                  };
                }

                answers[q.header] = answer;
              }

              this.setStoredStatus(scopeId, projectChannelId, "online");
              return { behavior: "allow" as const, updatedInput: { ...input, answers } };
            }

            const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
            if (readOnlyTools.includes(toolName)) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            const currentProject = getProject(projectChannelId);
            if (currentProject?.auto_approve) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            const requestId = randomUUID();
            const { embed, row } = createToolApprovalEmbed(toolName, input, requestId);

            this.setStoredStatus(scopeId, projectChannelId, "waiting");
            await channel.send({ embeds: [embed], components: [row] });

            return new Promise((resolve) => {
              const timeout = setTimeout(() => {
                pendingApprovals.delete(requestId);
                this.setStoredStatus(scopeId, projectChannelId, "online");
                resolve({ behavior: "deny" as const, message: "Approval timed out" });
              }, 5 * 60 * 1000);

              pendingApprovals.set(requestId, {
                resolve: (decision) => {
                  clearTimeout(timeout);
                  pendingApprovals.delete(requestId);
                  this.setStoredStatus(scopeId, projectChannelId, "online");
                  resolve(
                    decision.behavior === "allow"
                      ? { behavior: "allow" as const, updatedInput: input }
                      : { behavior: "deny" as const, message: decision.message ?? "Denied by user" },
                  );
                },
                scopeId,
              });
            });
          },
        },
      });

      this.sessions.set(scopeId, {
        queryInstance,
        scopeId,
        projectChannelId,
        sessionId: resumeSessionId ?? null,
        dbId,
        topic,
      });

      for await (const message of queryInstance) {
        const directUsage = (message as { usage?: { input_tokens?: number } }).usage;
        const nestedUsage = (message as { message?: { usage?: { input_tokens?: number } } }).message?.usage;
        const inputTokens = directUsage?.input_tokens ?? nestedUsage?.input_tokens ?? 0;
        if (typeof inputTokens === "number" && inputTokens > maxInputTokens) {
          maxInputTokens = inputTokens;
        }

        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          const sdkSessionId = (message as { session_id?: string }).session_id;
          if (sdkSessionId) {
            const active = this.sessions.get(scopeId);
            if (active) active.sessionId = sdkSessionId;
            if (scopeId === projectChannelId) {
              upsertSession(dbId, projectChannelId, sdkSessionId, "online");
            } else {
              upsertThreadSession(scopeId, projectChannelId, sdkSessionId, "online", topic);
            }
          }
        }

        if (message.type === "assistant" && "content" in message) {
          const content = message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if ("text" in block && typeof block.text === "string") {
                responseBuffer += block.text;
                hasTextOutput = true;
              }
            }
          }

          const now = Date.now();
          if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
            lastEditTime = now;
            const chunks = splitMessage(responseBuffer);
            try {
              if (!currentMessage) {
                currentMessage = await channel.send(chunks[0] || "...");
              } else {
                await currentMessage.edit({ content: chunks[0] || "..." });
              }
              for (let i = 1; i < chunks.length; i++) {
                currentMessage = await channel.send(chunks[i]);
                responseBuffer = chunks.slice(i + 1).join("");
              }
            } catch (e) {
              console.warn(`[stream] Failed to edit message for ${scopeId}, sending new:`, e instanceof Error ? e.message : e);
              currentMessage = await channel.send(chunks[chunks.length - 1] || "...");
            }
          }
        }

        if ("result" in message) {
          const resultMsg = message as { result?: string; total_cost_usd?: number; duration_ms?: number };

          if (responseBuffer.length > 0) {
            const chunks = splitMessage(responseBuffer);
            try {
              if (!currentMessage) {
                currentMessage = await channel.send(chunks[0] || L("Done.", "완료."));
              } else {
                await currentMessage.edit(chunks[0] || L("Done.", "완료."));
              }
              for (let i = 1; i < chunks.length; i++) {
                await channel.send(chunks[i]);
              }
            } catch (e) {
              console.warn(`[flush] Failed to edit final message for ${scopeId}:`, e instanceof Error ? e.message : e);
            }
          }

          const resultText = resultMsg.result ?? L("Task completed", "작업 완료");
          const usageSummary = await getUsageSummaryLine();
          const usageSnapshot = await getUsageSnapshot();
          const contextSummary = maxInputTokens > 0
            ? `~${Math.max(1, Math.min(100, Math.round((maxInputTokens / 200_000) * 100)))}% (${maxInputTokens.toLocaleString()} tok)`
            : null;
          const ctxPercent = maxInputTokens > 0
            ? Math.max(1, Math.min(100, Math.round((maxInputTokens / 200_000) * 100)))
            : 0;
          const sessionMinutes = Math.max(1, Math.round((Date.now() - startTime) / 60000));
          const primarySkill = selectedSkills[0] ?? "none";
          const fiveHourText = usageSnapshot?.fiveHourPct !== undefined
            ? `5h:${usageSnapshot.fiveHourPct}%(${usageSnapshot.fiveHourRemaining ?? "-"})`
            : "5h:-";
          const weekText = usageSnapshot?.weekPct !== undefined
            ? `wk:${usageSnapshot.weekPct}%(${usageSnapshot.weekRemaining ?? "-"})`
            : "wk:-";
          const omcStatusLine = [
            `[OMC#${getVersionInfo().appVersion}]`,
            fiveHourText,
            weekText,
            `session:${sessionMinutes}m`,
            `skill:${primarySkill}`,
            `ctx:${ctxPercent}%`,
            `agents:1`,
            `🔧${toolUseCount} 🤖1 ⚡${project.auto_approve ? 1 : 0}`,
            `model:${effectiveModel ?? "default"}`,
            `cc:${getVersionInfo().claudeCodeVersion}`,
          ].join(" | ");
          const resultEmbed = createResultEmbed(
            resultText,
            resultMsg.total_cost_usd ?? 0,
            resultMsg.duration_ms ?? 0,
            getConfig().SHOW_COST,
            usageSummary,
            contextSummary,
            omcStatusLine,
          );
          await channel.send({ embeds: [resultEmbed] });

          const resultAuthKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
          const lowerResult = resultText.toLowerCase();
          if (resultAuthKeywords.some((kw) => lowerResult.includes(kw))) {
            await channel.send(L(
              "🔑 Claude Code is not logged in. Please open a terminal on the host PC and run `claude login` to authenticate, then try again.",
              "🔑 Claude Code 로그인이 필요합니다. 호스트 PC에서 터미널을 열고 `claude login`을 실행하여 인증 후 다시 시도해 주세요.",
            ));
          }

          this.setStoredStatus(scopeId, projectChannelId, "idle");
          hasResult = true;
        }
      }
    } catch (error) {
      if (hasResult) {
        console.warn(`[session] Ignoring post-result error for ${scopeId}:`, error instanceof Error ? error.message : error);
        return;
      }

      const rawMsg = error instanceof Error ? error.message : "Unknown error occurred";
      let errMsg = rawMsg;
      const jsonMatch = rawMsg.match(/API Error: (\d+)\s*(\{.*\})/s);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[2]);
          const statusCode = jsonMatch[1];
          const message = parsed?.error?.message ?? parsed?.message ?? "Unknown error";
          errMsg = `API Error ${statusCode}: ${message}. Please try again later.`;
        } catch (parseErr) {
          console.warn(`[error-parse] Failed to parse API error JSON for ${scopeId}:`, parseErr instanceof Error ? parseErr.message : parseErr);
          errMsg = `API Error ${jsonMatch[1]}. Please try again later.`;
        }
      } else if (rawMsg.includes("process exited with code")) {
        errMsg = `${rawMsg}. The server may be temporarily unavailable — please try again later.`;
      }

      const authKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
      const lowerMsg = rawMsg.toLowerCase();
      if (authKeywords.some((kw) => lowerMsg.includes(kw))) {
        errMsg += L(
          "\n\n🔑 Claude Code is not logged in. Please open a terminal on the host PC and run `claude login` to authenticate, then try again.",
          "\n\n🔑 Claude Code 로그인이 필요합니다. 호스트 PC에서 터미널을 열고 `claude login`을 실행하여 인증 후 다시 시도해 주세요.",
        );
      }

      await channel.send(`❌ ${errMsg}`);
      this.setStoredStatus(scopeId, projectChannelId, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      this.sessions.delete(scopeId);

      for (const [id, entry] of pendingApprovals) {
        if (entry.scopeId === scopeId) pendingApprovals.delete(id);
      }
      for (const [id, entry] of pendingQuestions) {
        if (entry.scopeId === scopeId) pendingQuestions.delete(id);
      }
      pendingCustomInputs.delete(scopeId);

      const queue = this.messageQueue.get(scopeId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.messageQueue.delete(scopeId);
        const remaining = queue.length;
        const preview = next.prompt.length > 40 ? next.prompt.slice(0, 40) + "…" : next.prompt;
        const msg = remaining > 0
          ? L(`📨 Processing queued message... (remaining: ${remaining})\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다... (남은 큐: ${remaining}개)\n> ${preview}`)
          : L(`📨 Processing queued message...\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다...\n> ${preview}`);
        channel.send(msg).catch(() => {});
        this.sendMessage(next.channel, next.prompt, { scopeId, projectChannelId, topic }).catch((err) => {
          console.error("Queue sendMessage error:", err);
        });
      }
    }
  }

  async stopSession(scopeId: string): Promise<boolean> {
    const session = this.sessions.get(scopeId);
    if (!session) return false;

    try {
      await session.queryInstance.interrupt();
    } catch {
      // ignore
    }

    this.sessions.delete(scopeId);

    for (const [id, entry] of pendingApprovals) {
      if (entry.scopeId === scopeId) pendingApprovals.delete(id);
    }
    for (const [id, entry] of pendingQuestions) {
      if (entry.scopeId === scopeId) pendingQuestions.delete(id);
    }
    pendingCustomInputs.delete(scopeId);

    this.setStoredStatus(scopeId, session.projectChannelId, "offline");
    return true;
  }

  isActive(scopeId: string): boolean {
    return this.sessions.has(scopeId);
  }

  resolveApproval(requestId: string, decision: "approve" | "deny" | "approve-all"): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;

    if (decision === "approve-all") {
      const project = getProject(pending.scopeId) ?? getProject(this.sessions.get(pending.scopeId)?.projectChannelId ?? "");
      if (project) setAutoApprove(project.channel_id, true);
      pending.resolve({ behavior: "allow" });
    } else if (decision === "approve") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user" });
    }

    return true;
  }

  resolveQuestion(requestId: string, answer: string): boolean {
    const pending = pendingQuestions.get(requestId);
    if (!pending) return false;
    pending.resolve(answer);
    return true;
  }

  enableCustomInput(requestId: string, scopeId: string): void {
    pendingCustomInputs.set(scopeId, { requestId });
  }

  resolveCustomInput(scopeId: string, text: string): boolean {
    const ci = pendingCustomInputs.get(scopeId);
    if (!ci) return false;
    pendingCustomInputs.delete(scopeId);

    const pending = pendingQuestions.get(ci.requestId);
    if (!pending) return false;
    pending.resolve(text);
    return true;
  }

  hasPendingCustomInput(scopeId: string): boolean {
    return pendingCustomInputs.has(scopeId);
  }

  setPendingQueue(scopeId: string, channel: TextChannel, prompt: string): void {
    this.pendingQueuePrompts.set(scopeId, { channel, prompt });
  }

  confirmQueue(scopeId: string): boolean {
    const pending = this.pendingQueuePrompts.get(scopeId);
    if (!pending) return false;
    this.pendingQueuePrompts.delete(scopeId);
    const queue = this.messageQueue.get(scopeId) ?? [];
    queue.push(pending);
    this.messageQueue.set(scopeId, queue);
    return true;
  }

  enqueueMessage(scopeId: string, channel: TextChannel, prompt: string): boolean {
    if (this.isQueueFull(scopeId)) return false;
    const queue = this.messageQueue.get(scopeId) ?? [];
    queue.push({ channel, prompt });
    this.messageQueue.set(scopeId, queue);
    return true;
  }

  cancelQueue(scopeId: string): void {
    this.pendingQueuePrompts.delete(scopeId);
  }

  isQueueFull(scopeId: string): boolean {
    return (this.messageQueue.get(scopeId) ?? []).length >= SessionManager.MAX_QUEUE_SIZE;
  }

  getQueueSize(scopeId: string): number {
    return (this.messageQueue.get(scopeId) ?? []).length;
  }

  hasQueue(scopeId: string): boolean {
    return this.pendingQueuePrompts.has(scopeId);
  }

  getQueue(scopeId: string): { channel: TextChannel; prompt: string }[] {
    return this.messageQueue.get(scopeId) ?? [];
  }

  clearQueue(scopeId: string): number {
    const queue = this.messageQueue.get(scopeId) ?? [];
    const count = queue.length;
    this.messageQueue.delete(scopeId);
    this.pendingQueuePrompts.delete(scopeId);
    return count;
  }

  removeFromQueue(scopeId: string, index: number): string | null {
    const queue = this.messageQueue.get(scopeId);
    if (!queue || index < 0 || index >= queue.length) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.messageQueue.delete(scopeId);
      this.pendingQueuePrompts.delete(scopeId);
    }
    return removed.prompt;
  }
}

export const sessionManager = new SessionManager();
