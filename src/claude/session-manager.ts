import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  setAutoApprove,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import {
  createToolApprovalEmbed,
  createAskUserQuestionEmbed,
  createResultEmbed,
  createStopButton,
  splitMessage,
  type AskQuestionData,
} from "./output-formatter.js";

interface ActiveSession {
  queryInstance: Query;
  channelId: string;
  sessionId: string | null; // Claude Agent SDK session ID
  dbId: string;
}

// Pending approval requests: requestId -> resolve function
const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
    channelId: string;
  }
>();

// Pending AskUserQuestion requests: requestId -> resolve function
const pendingQuestions = new Map<
  string,
  {
    resolve: (answer: string | null) => void;
    channelId: string;
  }
>();

// Pending custom text inputs: channelId -> requestId
const pendingCustomInputs = new Map<string, { requestId: string }>();

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();

  async sendMessage(
    channel: TextChannel,
    prompt: string,
  ): Promise<void> {
    const channelId = channel.id;
    const project = getProject(channelId);
    if (!project) return;

    const existingSession = this.sessions.get(channelId);
    // If no in-memory session, check DB for previous session_id (for bot restart resume)
    const dbSession = !existingSession ? getSession(channelId) : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    const resumeSessionId = existingSession?.sessionId ?? dbSession?.session_id ?? undefined;

    // Update status to online
    upsertSession(dbId, channelId, resumeSessionId ?? null, "online");

    // Streaming state
    let responseBuffer = "";
    let lastEditTime = 0;
    const stopRow = createStopButton(channelId);
    let currentMessage = await channel.send({
      content: "⏳ Thinking...",
      components: [stopRow],
    });
    const EDIT_INTERVAL = 1500; // ms between edits (Discord rate limit friendly)

    // Activity tracking for progress display
    const startTime = Date.now();
    let lastActivity = "Thinking...";
    let toolUseCount = 0;
    let hasTextOutput = false;

    // Heartbeat timer - updates status message every 15s when no text output yet
    const heartbeatInterval = setInterval(async () => {
      if (hasTextOutput) return; // stop heartbeat once real content is streaming
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      try {
        await currentMessage.edit({
          content: `⏳ ${lastActivity} (${timeStr})`,
          components: [stopRow],
        });
      } catch {
        // ignore edit failures
      }
    }, 15_000);

    try {
      const queryInstance = query({
        prompt,
        options: {
          cwd: project.project_path,
          permissionMode: "default",
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),

          canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
          ) => {
            toolUseCount++;

            // Tool activity labels for Discord display
            const toolLabels: Record<string, string> = {
              Read: "Reading files",
              Glob: "Searching files",
              Grep: "Searching code",
              Write: "Writing file",
              Edit: "Editing file",
              Bash: "Running command",
              WebSearch: "Searching web",
              WebFetch: "Fetching URL",
              TodoWrite: "Updating tasks",
            };
            const filePath = typeof input.file_path === "string"
              ? ` \`${(input.file_path as string).split(/[\\/]/).pop()}\``
              : "";
            lastActivity = `${toolLabels[toolName] ?? `Using ${toolName}`}${filePath}`;

            // Update status message if no text output yet
            if (!hasTextOutput) {
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              const timeStr = elapsed > 60
                ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                : `${elapsed}s`;
              try {
                await currentMessage.edit({
                  content: `⏳ ${lastActivity} (${timeStr}) [${toolUseCount} tools used]`,
                  components: [stopRow],
                });
              } catch {
                // ignore
              }
            }

            // Handle AskUserQuestion with interactive Discord UI
            if (toolName === "AskUserQuestion") {
              const questions = (input.questions as AskQuestionData[]) ?? [];
              if (questions.length === 0) {
                return { behavior: "allow" as const, updatedInput: input };
              }

              const answers: Record<string, string> = {};

              for (let qi = 0; qi < questions.length; qi++) {
                const q = questions[qi];
                const qRequestId = randomUUID();
                const { embed, components } = createAskUserQuestionEmbed(
                  q,
                  qRequestId,
                  qi,
                  questions.length,
                );

                updateSessionStatus(channelId, "waiting");
                await channel.send({ embeds: [embed], components });

                const answer = await new Promise<string | null>((resolve) => {
                  const timeout = setTimeout(() => {
                    pendingQuestions.delete(qRequestId);
                    // Clean up custom input if pending
                    const ci = pendingCustomInputs.get(channelId);
                    if (ci?.requestId === qRequestId) {
                      pendingCustomInputs.delete(channelId);
                    }
                    resolve(null);
                  }, 5 * 60 * 1000);

                  pendingQuestions.set(qRequestId, {
                    resolve: (ans) => {
                      clearTimeout(timeout);
                      pendingQuestions.delete(qRequestId);
                      resolve(ans);
                    },
                    channelId,
                  });
                });

                if (answer === null) {
                  updateSessionStatus(channelId, "online");
                  return {
                    behavior: "deny" as const,
                    message: "Question timed out",
                  };
                }

                answers[q.header] = answer;
              }

              updateSessionStatus(channelId, "online");
              return {
                behavior: "allow" as const,
                updatedInput: { ...input, answers },
              };
            }

            // Auto-approve read-only tools
            const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
            if (readOnlyTools.includes(toolName)) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            // Check auto-approve setting
            const currentProject = getProject(channelId);
            if (currentProject?.auto_approve) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            // Ask user via Discord buttons
            const requestId = randomUUID();
            const { embed, row } = createToolApprovalEmbed(
              toolName,
              input,
              requestId,
            );

            updateSessionStatus(channelId, "waiting");
            await channel.send({
              embeds: [embed],
              components: [row],
            });

            // Wait for user decision (timeout 5 min)
            return new Promise((resolve) => {
              const timeout = setTimeout(() => {
                pendingApprovals.delete(requestId);
                updateSessionStatus(channelId, "online");
                resolve({ behavior: "deny" as const, message: "Approval timed out" });
              }, 5 * 60 * 1000);

              pendingApprovals.set(requestId, {
                resolve: (decision) => {
                  clearTimeout(timeout);
                  pendingApprovals.delete(requestId);
                  updateSessionStatus(channelId, "online");
                  resolve(
                    decision.behavior === "allow"
                      ? { behavior: "allow" as const, updatedInput: input }
                      : { behavior: "deny" as const, message: decision.message ?? "Denied by user" },
                  );
                },
                channelId,
              });
            });
          },
        },
      });

      // Store the active session
      this.sessions.set(channelId, {
        queryInstance,
        channelId,
        sessionId: resumeSessionId ?? null,
        dbId,
      });

      for await (const message of queryInstance) {
        // Capture session ID
        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "init"
        ) {
          const sdkSessionId = (message as { session_id?: string }).session_id;
          if (sdkSessionId) {
            const active = this.sessions.get(channelId);
            if (active) active.sessionId = sdkSessionId;
            upsertSession(dbId, channelId, sdkSessionId, "online");
          }
        }

        // Handle streaming text
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

          // Throttled message edit
          const now = Date.now();
          if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
            lastEditTime = now;
            const chunks = splitMessage(responseBuffer);
            try {
              await currentMessage.edit({ content: chunks[0] || "...", components: [] });
              // Send additional chunks as new messages
              for (let i = 1; i < chunks.length; i++) {
                currentMessage = await channel.send(chunks[i]);
                responseBuffer = chunks.slice(i + 1).join("");
              }
            } catch {
              // Message may have been deleted, send new one
              currentMessage = await channel.send(
                chunks[chunks.length - 1] || "...",
              );
            }
          }
        }

        // Handle result
        if ("result" in message) {
          const resultMsg = message as {
            result?: string;
            total_cost_usd?: number;
            duration_ms?: number;
          };

          // Flush remaining buffer
          if (responseBuffer.length > 0) {
            const chunks = splitMessage(responseBuffer);
            try {
              await currentMessage.edit(chunks[0] || "Done.");
              for (let i = 1; i < chunks.length; i++) {
                await channel.send(chunks[i]);
              }
            } catch {
              // ignore
            }
          }

          // Send result embed
          const resultEmbed = createResultEmbed(
            resultMsg.result ?? "Task completed",
            resultMsg.total_cost_usd ?? 0,
            resultMsg.duration_ms ?? 0,
            getConfig().SHOW_COST,
          );
          await channel.send({ embeds: [resultEmbed] });

          updateSessionStatus(channelId, "idle");
        }
      }
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : "Unknown error occurred";
      await channel.send(`❌ Error: ${errMsg}`);
      updateSessionStatus(channelId, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      this.sessions.delete(channelId);

      // Process next queued message if any
      const next = this.messageQueue.get(channelId);
      if (next) {
        this.messageQueue.delete(channelId);
        channel.send("📨 대기 중이던 메시지를 처리합니다...").catch(() => {});
        this.sendMessage(next.channel, next.prompt);
      }
    }
  }

  async stopSession(channelId: string): Promise<boolean> {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    try {
      await session.queryInstance.interrupt();
    } catch {
      // already stopped
    }

    this.sessions.delete(channelId);
    updateSessionStatus(channelId, "offline");
    return true;
  }

  isActive(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  resolveApproval(
    requestId: string,
    decision: "approve" | "deny" | "approve-all",
  ): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;

    if (decision === "approve-all") {
      // Enable auto-approve for this channel
      setAutoApprove(pending.channelId, true);
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

  enableCustomInput(requestId: string, channelId: string): void {
    pendingCustomInputs.set(channelId, { requestId });
  }

  resolveCustomInput(channelId: string, text: string): boolean {
    const ci = pendingCustomInputs.get(channelId);
    if (!ci) return false;
    pendingCustomInputs.delete(channelId);

    const pending = pendingQuestions.get(ci.requestId);
    if (!pending) return false;
    pending.resolve(text);
    return true;
  }

  hasPendingCustomInput(channelId: string): boolean {
    return pendingCustomInputs.has(channelId);
  }

  // --- Message queue ---

  setPendingQueue(channelId: string, channel: TextChannel, prompt: string): void {
    this.pendingQueuePrompts.set(channelId, { channel, prompt });
  }

  confirmQueue(channelId: string): boolean {
    const pending = this.pendingQueuePrompts.get(channelId);
    if (!pending) return false;
    this.pendingQueuePrompts.delete(channelId);
    this.messageQueue.set(channelId, pending);
    return true;
  }

  cancelQueue(channelId: string): void {
    this.pendingQueuePrompts.delete(channelId);
  }

  hasQueue(channelId: string): boolean {
    return this.messageQueue.has(channelId) || this.pendingQueuePrompts.has(channelId);
  }
}

export const sessionManager = new SessionManager();
