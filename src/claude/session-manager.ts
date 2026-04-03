import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MessageCreateOptions, MessageEditOptions, TextChannel } from "discord.js";
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
import {
  createToolApprovalEmbed,
  createAskUserQuestionEmbed,
  createResultEmbed,
  formatStreamChunk,
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
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string; sourceMessageId?: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string; sourceMessageId?: string }>();
  private forceFreshNext = new Set<string>();
  private forceUltraFastNext = new Set<string>();

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
    options?: {
      scopeId?: string;
      projectChannelId?: string;
      topic?: string | null;
      preferFreshSession?: boolean;
      preferUltraFast?: boolean;
      sourceMessageId?: string;
    },
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
    const loadedResumeSessionId = existingSession?.sessionId ?? dbSession?.session_id ?? undefined;
    const forcedUltraFast = this.forceUltraFastNext.has(scopeId);
    const shouldForceFresh = this.forceFreshNext.has(scopeId) || Boolean(options?.preferFreshSession) || forcedUltraFast;
    const resumeSessionId = shouldForceFresh ? undefined : loadedResumeSessionId;
    if (shouldForceFresh) this.forceFreshNext.delete(scopeId);
    if (forcedUltraFast) this.forceUltraFastNext.delete(scopeId);
    const topic = options?.topic ?? existingSession?.topic ?? dbSession?.topic ?? null;
    const sourceMessageId = options?.sourceMessageId;
    const sessionMode = loadedResumeSessionId
      ? L("Resumed", "이어쓰기")
      : L("Fresh", "새 세션");
    const selectedSkills = project.skills
      ? project.skills.split(",").map((skill) => skill.trim()).filter(Boolean)
      : [];

    const sendToChannel = async (payload: string | MessageCreateOptions): Promise<any> => {
      if (typeof payload === "string") {
        if (sourceMessageId) {
          return channel.send({
            content: payload,
            reply: { messageReference: sourceMessageId },
            allowedMentions: { repliedUser: false },
          });
        }
        return channel.send(payload);
      }

      if (sourceMessageId) {
        return channel.send({
          ...payload,
          reply: { messageReference: sourceMessageId },
          allowedMentions: { repliedUser: false, ...(payload.allowedMentions ?? {}) },
        });
      }

      return channel.send(payload);
    };

    if (scopeId === projectChannelId) {
      upsertSession(dbId, projectChannelId, resumeSessionId ?? null, "online");
    } else {
      upsertThreadSession(scopeId, projectChannelId, resumeSessionId ?? null, "online", topic);
    }

    let responseBuffer = "";
    let lastEditTime = 0;
    let currentMessage: { edit: (v: any) => Promise<any> } | null = null;
    let progressMessage: { edit: (v: any) => Promise<any>; delete?: () => Promise<any> } | null = null;
    const EDIT_INTERVAL = 1500;
    const PROGRESS_EDIT_INTERVAL = 1200;
    let lastProgressEditTime = 0;
    let streamEventCount = 0;
    let progressTick = 0;

    const startTime = Date.now();
    const requestSentAt = Date.now();
    let firstEventAt: number | null = null;
    let firstTextAt: number | null = null;
    let lastActivity = L("Thinking...", "생각 중...");
    let toolUseCount = 0;
    let hasTextOutput = false;
    let hasResult = false;
    let maxInputTokens = 0;
    const activityLog: string[] = [];
    let lastStreamEventLabel = L("none", "없음");
    let progressDetail = L("Preparing request", "요청 준비 중");
    let lastLoggedStep = "";
    let lastGenericReasoningLogAt = 0;

    const pushActivityLog = (entry: string): void => {
      if (!entry.trim()) return;
      activityLog.push(entry);
      if (activityLog.length > 12) activityLog.shift();
    };

    const logStepIfChanged = (step: string): void => {
      if (!step.trim()) return;
      if (step === lastLoggedStep) return;
      const now = Date.now();
      const genericSteps = new Set([
        L("Reasoning and planning", "추론 및 계획 중"),
        L("Generating reply text", "답변 텍스트 생성 중"),
      ]);
      // Avoid flooding timeline with repetitive generic states.
      if (genericSteps.has(step) && now - lastGenericReasoningLogAt < 15000) return;
      if (genericSteps.has(step)) lastGenericReasoningLogAt = now;
      lastLoggedStep = step;
      pushActivityLog(step);
    };

    const describeToolStep = (toolName: string, input: Record<string, unknown>): string => {
      if (toolName === "Read") {
        const filePath = typeof input.file_path === "string" ? input.file_path : "";
        return filePath
          ? L(`Reading ${filePath}`, `${filePath} 읽는 중`)
          : L("Reading a file", "파일 읽는 중");
      }
      if (toolName === "Edit" || toolName === "Write") {
        const filePath = typeof input.file_path === "string" ? input.file_path : "";
        return filePath
          ? L(`Editing ${filePath}`, `${filePath} 수정 중`)
          : L("Editing file content", "파일 내용 수정 중");
      }
      if (toolName === "Glob" || toolName === "Grep") {
        const pattern = typeof input.pattern === "string" ? input.pattern : "";
        return pattern
          ? L(`Searching code: ${pattern}`, `코드 검색: ${pattern}`)
          : L("Searching code", "코드 검색 중");
      }
      if (toolName === "Bash") {
        const cmd = typeof input.command === "string" ? input.command : "";
        const short = cmd.length > 90 ? `${cmd.slice(0, 90)}...` : cmd;
        return short
          ? L(`Running command: ${short}`, `명령 실행: ${short}`)
          : L("Running shell command", "쉘 명령 실행 중");
      }
      if (toolName === "WebSearch" || toolName === "WebFetch") {
        return L("Checking web references", "웹 참고자료 확인 중");
      }
      return L(`Using tool: ${toolName}`, `도구 사용: ${toolName}`);
    };

    const updateProgress = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastProgressEditTime < PROGRESS_EDIT_INTERVAL) return;
      lastProgressEditTime = now;

      const elapsedSec = Math.max(1, Math.floor((now - startTime) / 1000));
      const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      const spinner = spinnerFrames[progressTick % spinnerFrames.length];
      const recent = activityLog.slice(-8);
      const lines: string[] = [
        `• ${L("Session", "세션")}: ${sessionMode}`,
        `• ${L("Status", "상태")}: ${lastActivity}`,
        `• ${L("Tools", "도구")}: ${toolUseCount}`,
      ];
      if (recent.length > 0) {
        lines.push(`• ${L("Process", "과정 누적")}:`);
        for (const item of recent) lines.push(`• ${item}`);
      }
      if (hasTextOutput) {
        lines.push(`↳ ${L("Reply stream active", "답변 스트림 진행 중")}`);
      }
      lines.push(`${spinner} ${L("In progress", "진행 중")} (${elapsedSec}s)`);

      const body = lines.join("\n");
      try {
        if (!progressMessage) {
          progressMessage = await sendToChannel(body);
        } else {
          await progressMessage.edit({ content: body });
        }
      } catch (e) {
        console.warn(`[progress] Failed to update progress for ${scopeId}:`, e instanceof Error ? e.message : e);
      }
    };

    // Keep progress visibly alive even when no tool/text events arrive for a while.
    const progressInterval = setInterval(() => {
      progressTick++;
      updateProgress(true).catch(() => {});
    }, 3000);

    const heartbeatInterval = setInterval(async () => {
      if (hasTextOutput) return;
      try {
        await channel.sendTyping();
      } catch (e) {
        console.warn(`[heartbeat] Failed to send typing for ${scopeId}:`, e instanceof Error ? e.message : e);
      }
    }, 15_000);

    try {
      await updateProgress(true);
      const promptWithContext = !resumeSessionId && scopeId !== projectChannelId
        ? [
            buildSkillIntro(selectedSkills),
            buildDefaultOpsHint(),
            prompt,
          ].filter(Boolean).join("\n\n")
        : prompt;
      if (options?.preferFreshSession) {
        logStepIfChanged(L("Fast path enabled for short prompt", "짧은 요청용 빠른 경로 사용"));
      }
      if (options?.preferUltraFast || forcedUltraFast) {
        logStepIfChanged(L("Ultra-fast mode enabled", "초고속 모드 사용"));
      }
      progressDetail = L("Request sent, waiting first response", "요청 전송됨, 첫 응답 대기 중");
      updateProgress(true).catch(() => {});

      const globalModel = getGlobalModel();
      const effectiveModel = dbSession?.model ?? project.model ?? globalModel ?? undefined;
      const ultraFastModel = (options?.preferUltraFast || forcedUltraFast)
        ? (effectiveModel && effectiveModel !== "default" ? effectiveModel : "haiku")
        : effectiveModel;

      const queryInstance = query({
        prompt: promptWithContext,
        options: {
          cwd: project.project_path,
          permissionMode: "default",
          settings: {
            disableAllHooks: true,
          },
          settingSources: [],
          ...(ultraFastModel ? { model: ultraFastModel } : {}),
          ...((options?.preferUltraFast || forcedUltraFast) ? { maxTurns: 1, promptSuggestions: false, agentProgressSummaries: false } : {}),
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
            progressDetail = lastActivity;
            logStepIfChanged(lastActivity);
            logStepIfChanged(describeToolStep(toolName, input));
            updateProgress().catch(() => {});

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
                await sendToChannel({ embeds: [embed], components });

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
            await sendToChannel({ embeds: [embed], components: [row] });

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
        streamEventCount++;
        if (firstEventAt === null) {
          firstEventAt = Date.now();
          const waitMs = firstEventAt - requestSentAt;
          const waitMsg = L(
            `First event received in ${(waitMs / 1000).toFixed(1)}s`,
            `첫 이벤트 수신 ${(waitMs / 1000).toFixed(1)}초`,
          );
          logStepIfChanged(waitMsg);
          progressDetail = waitMsg;
          updateProgress(true).catch(() => {});
        }
        if ("type" in message && typeof message.type === "string") {
          if (message.type === "assistant") {
            const hasText = "content" in message
              && Array.isArray((message as { content?: unknown }).content)
              && (message as { content: Array<{ text?: string }> }).content.some((b) => typeof b?.text === "string" && b.text.length > 0);
            lastStreamEventLabel = hasText ? "assistant:text" : "assistant:event";
            progressDetail = hasText
              ? L("Generating reply text", "답변 텍스트 생성 중")
              : L("Reasoning and planning", "추론 및 계획 중");
            logStepIfChanged(progressDetail);
            if (hasText && "content" in message && Array.isArray((message as { content?: unknown[] }).content)) {
              const textParts = (message as { content: Array<{ text?: string }> }).content
                .map((b) => (typeof b.text === "string" ? b.text.trim() : ""))
                .filter(Boolean);
              if (textParts.length > 0) {
                const preview = textParts.join(" ").replace(/\s+/g, " ").slice(0, 120);
                if (preview.length > 0) {
                  logStepIfChanged(L(`Drafting: ${preview}`, `응답 작성: ${preview}`));
                }
              }
            }
          } else if (message.type === "system") {
            const subtype = ("subtype" in message && typeof message.subtype === "string") ? message.subtype : "event";
            lastStreamEventLabel = `system:${subtype}`;
            const noisy = ["hook_started", "hook_response", "status", "user"];
            if (!noisy.includes(subtype)) {
              progressDetail = `system:${subtype}`;
              logStepIfChanged(progressDetail);
            }
            if (subtype === "compact_boundary") {
              this.forceFreshNext.add(scopeId);
              const compactMsg = L(
                "Context compacted; next request will start a fresh session for speed",
                "컨텍스트 압축됨; 다음 요청은 속도를 위해 새 세션으로 시작",
              );
              progressDetail = compactMsg;
              logStepIfChanged(compactMsg);
            }
          } else if (message.type === "rate_limit_event") {
            lastStreamEventLabel = "rate_limit";
            const waitMsg = L("Anthropic rate limit, waiting to continue", "Anthropic rate limit 대기 중");
            progressDetail = waitMsg;
            logStepIfChanged(waitMsg);
            this.forceFreshNext.add(scopeId);
            this.forceUltraFastNext.add(scopeId);
            logStepIfChanged(L(
              "Next request will retry in fresh ultra-fast mode",
              "다음 요청은 새 세션 초고속 모드로 재시도",
            ));
          } else if (message.type === "user") {
            // Do not log internal synthetic user events in progress timeline.
          } else if ("result" in message) {
            lastStreamEventLabel = "result";
            progressDetail = L("Finalizing result", "최종 결과 정리 중");
            logStepIfChanged(progressDetail);
          } else {
            lastStreamEventLabel = message.type;
            // Hide noisy internal stream event labels from timeline.
            const hiddenTypes = new Set(["user", "system", "status", "hook_started", "hook_response"]);
            if (!hiddenTypes.has(message.type)) {
              progressDetail = message.type;
              logStepIfChanged(progressDetail);
            }
          }
        } else if ("result" in message) {
          lastStreamEventLabel = "result";
          progressDetail = L("Finalizing result", "최종 결과 정리 중");
          logStepIfChanged(progressDetail);
        }

        if (message.type === "system" && "subtype" in message && typeof message.subtype === "string") {
          if (message.subtype === "init") {
            // init is emitted even when resuming an existing session via resume id.
            const isResume = Boolean(resumeSessionId);
            lastActivity = isResume
              ? L("Session resumed", "세션 재개됨")
              : L("Session connected", "세션 연결됨");
            progressDetail = lastActivity;
            logStepIfChanged(lastActivity);
          }
        } else if (message.type === "assistant") {
          lastActivity = hasTextOutput ? L("Streaming response", "답변 스트리밍 중") : L("Reasoning", "추론 중");
          progressDetail = hasTextOutput ? L("Streaming reply output", "답변 출력 스트리밍 중") : L("Reasoning and planning", "추론 및 계획 중");
          logStepIfChanged(progressDetail);
        }

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
                if (firstTextAt === null) {
                  firstTextAt = Date.now();
                  const textWaitMs = firstTextAt - requestSentAt;
                  const textMsg = L(
                    `First text token in ${(textWaitMs / 1000).toFixed(1)}s`,
                    `첫 텍스트 토큰 ${(textWaitMs / 1000).toFixed(1)}초`,
                  );
                  logStepIfChanged(textMsg);
                  if (textWaitMs >= 15000) {
                    this.forceFreshNext.add(scopeId);
                    const slowMsg = L(
                      "Slow first token detected; next request will use fresh session",
                      "첫 토큰 지연 감지; 다음 요청은 새 세션 사용",
                    );
                    progressDetail = slowMsg;
                    logStepIfChanged(slowMsg);
                  }
                }
              }
            }
          }
          updateProgress().catch(() => {});

          const now = Date.now();
          if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
            lastEditTime = now;
            try {
              const liveText = formatStreamChunk(responseBuffer);
              if (!currentMessage) {
                currentMessage = await sendToChannel(liveText || "...");
              } else {
                await currentMessage.edit({ content: liveText || "..." });
              }
            } catch (e) {
              console.warn(`[stream] Failed to edit message for ${scopeId}:`, e instanceof Error ? e.message : e);
            }
          }
        }

        if ("result" in message) {
          const resultMsg = message as { result?: string; total_cost_usd?: number; duration_ms?: number };

          if (responseBuffer.length > 0) {
            try {
              const finalLiveText = formatStreamChunk(responseBuffer);
              if (!currentMessage) {
                currentMessage = await sendToChannel(finalLiveText || L("Done.", "완료."));
              } else {
                await currentMessage.edit({ content: finalLiveText || L("Done.", "완료.") });
              }
            } catch (e) {
              console.warn(`[flush] Failed to edit final message for ${scopeId}:`, e instanceof Error ? e.message : e);
            }
          }

          const resultText = resultMsg.result ?? L("Task completed", "작업 완료");
          const conclusion = resultText
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0)
            ?.slice(0, 180) ?? L("Task completed", "작업 완료");
          const usageSummary = await getUsageSummaryLine();
          const contextSummary = maxInputTokens > 0
            ? `~${Math.max(1, Math.min(100, Math.round((maxInputTokens / 200_000) * 100)))}% (${maxInputTokens.toLocaleString()} tok)`
            : null;
          const primarySkill = selectedSkills[0] ?? "none";
          const omcStatusLine = [
            `skill:${primarySkill}`,
            `agents:1`,
            `🔧${toolUseCount} 🤖1 ⚡${project.auto_approve ? 1 : 0}`,
            `model:${ultraFastModel ?? "default"}`,
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
          await sendToChannel({ embeds: [resultEmbed] });

          if (progressMessage) {
            const doneSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
            const doneLines = [
              `• ${L("Session", "세션")}: ${sessionMode}`,
              `✅ ${L("Completed", "완료")}: ${conclusion}`,
              `• ${L("Tools", "도구")}: ${toolUseCount}`,
              `• ${L("Elapsed", "소요 시간")}: ${doneSec}s`,
            ];
            if (activityLog.length > 0) {
              doneLines.push(`• ${L("Process", "과정")}:`);
              const recent = activityLog.slice(-8);
              for (const item of recent) doneLines.push(`• ${item}`);
            }
            await progressMessage.edit({ content: doneLines.join("\n") }).catch(() => {});
            setTimeout(() => {
              progressMessage?.delete?.().catch(() => {});
            }, 10_000);
          }

          const resultAuthKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
          const lowerResult = resultText.toLowerCase();
          if (resultAuthKeywords.some((kw) => lowerResult.includes(kw))) {
            await sendToChannel(L(
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

      await sendToChannel(`❌ ${errMsg}`);
      this.setStoredStatus(scopeId, projectChannelId, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      clearInterval(progressInterval);
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
        if (next.sourceMessageId) {
          channel.send({
            content: msg,
            reply: { messageReference: next.sourceMessageId },
            allowedMentions: { repliedUser: false },
          }).catch(() => {});
        } else {
          channel.send(msg).catch(() => {});
        }
        this.sendMessage(next.channel, next.prompt, { scopeId, projectChannelId, topic, sourceMessageId: next.sourceMessageId }).catch((err) => {
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

  setPendingQueue(scopeId: string, channel: TextChannel, prompt: string, sourceMessageId?: string): void {
    this.pendingQueuePrompts.set(scopeId, { channel, prompt, sourceMessageId });
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

  enqueueMessage(scopeId: string, channel: TextChannel, prompt: string, sourceMessageId?: string): boolean {
    if (this.isQueueFull(scopeId)) return false;
    const queue = this.messageQueue.get(scopeId) ?? [];
    queue.push({ channel, prompt, sourceMessageId });
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

  getQueue(scopeId: string): { channel: TextChannel; prompt: string; sourceMessageId?: string }[] {
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
