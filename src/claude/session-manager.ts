import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MessageCreateOptions, TextChannel } from "discord.js";
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
  createProgressControls,
  formatStreamChunk,
  splitMessage,
  type AskQuestionData,
} from "./output-formatter.js";
import { createProgressButtons } from "./progress-buttons.js";
import { addImprovements, createCheckpoint } from "./checkpoints.js";
import { getUsageSummaryLine } from "../bot/commands/usage.js";
import { isOperationalCheckpointNoise, pickCheckpointConclusion } from "../utils/checkpoint-review.js";
import { buildDefaultOpsHint, buildGlobalOpsPrompt, buildLocaleResponseHint, buildSkillIntro } from "../utils/skills.js";
import { extractCodexAutoDecision } from "../utils/codex.js";

function extractCheckpointInsights(resultText: string): string[] {
  const lines = resultText.split(/\r?\n/).map((line) => line.trim());
  const insights: string[] = [];
  const seen = new Set<string>();

  const push = (value: string): void => {
    const cleaned = value.replace(/^[-*•]\s*/, "").trim();
    if (!cleaned) return;
    if (isOperationalCheckpointNoise(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    insights.push(cleaned.length > 220 ? `${cleaned.slice(0, 220)}...` : cleaned);
  };

  const sectionHints = ["reflection", "improvement", "next step", "회고", "개선점", "다음단계", "다음 단계", "제안"];
  let inHintSection = false;

  for (const line of lines) {
    if (!line) continue;
    const lower = line.toLowerCase();
    const isHeader = sectionHints.some((hint) => lower.includes(hint)) && /^[\[\]#*\sA-Za-z가-힣0-9:_-]+$/.test(line);
    if (isHeader) {
      inHintSection = true;
      continue;
    }
    if (/^\[[^\]]+\]/.test(line) && !isHeader) {
      inHintSection = false;
      continue;
    }
    if (inHintSection) {
      push(line);
      continue;
    }
    if (/^(next|다음)\s*(step|단계)/i.test(line)) push(line);
    if (/^(improvement|개선점)/i.test(line)) push(line);
  }

  return insights.slice(0, 8);
}

interface ActiveSession {
  queryInstance: Query;
  scopeId: string;
  projectChannelId: string;
  sessionId: string | null;
  dbId: string;
  topic: string | null;
  stopped?: boolean;
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
  private scopeTokenWatermark = new Map<string, number>();
  private pendingManualCodex = new Map<string, { model: string; context: string }>();

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
    const persistedDbId = dbSession && "id" in dbSession ? dbSession.id : undefined;
    const dbId = existingSession?.dbId ?? persistedDbId ?? randomUUID();
    const loadedResumeSessionId = existingSession?.sessionId ?? dbSession?.session_id ?? undefined;
    const forcedFreshNext = this.forceFreshNext.has(scopeId);
    const forcedUltraFast = this.forceUltraFastNext.has(scopeId);
    const hasSavedSession = Boolean(loadedResumeSessionId);
    const shouldForceFresh = Boolean(options?.preferFreshSession)
      || (!hasSavedSession && (forcedFreshNext || forcedUltraFast));
    const useUltraFastMode = Boolean(options?.preferUltraFast)
      || (!hasSavedSession && forcedUltraFast);
    const resumeSessionId = shouldForceFresh ? undefined : loadedResumeSessionId;
    if (shouldForceFresh) this.forceFreshNext.delete(scopeId);
    if (forcedUltraFast) this.forceUltraFastNext.delete(scopeId);
    if (shouldForceFresh) this.scopeTokenWatermark.delete(scopeId);
    const persistedTopic = dbSession && "topic" in dbSession ? dbSession.topic : null;
    const topic = options?.topic ?? existingSession?.topic ?? persistedTopic ?? null;
    const sourceMessageId = options?.sourceMessageId;
    const sessionMode = loadedResumeSessionId
      ? L("Resumed", "이어쓰기")
      : L("Fresh", "새 세션");
    const selectedSkills = project.skills
      ? project.skills.split(",").map((skill) => skill.trim()).filter(Boolean)
      : [];
    const compactPrompt = prompt.replace(/\s+/g, " ").trim();
    const promptPreview = compactPrompt.length > 140 ? `${compactPrompt.slice(0, 140)}…` : compactPrompt;

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
    // Keep text stream updates responsive while adapting to Discord edit pressure.
    const MIN_EDIT_INTERVAL = 250;
    const MAX_EDIT_INTERVAL = 1200;
    let editInterval = MIN_EDIT_INTERVAL;
    let editSuccessStreak = 0;
    const PROGRESS_EDIT_INTERVAL = 500; // Faster update: 900ms → 500ms (진행 상황 더 자주 표시)
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
    let sawCompactBoundary = false;
    const previousTokenWatermark = resumeSessionId ? (this.scopeTokenWatermark.get(scopeId) ?? 0) : 0;
    let maxInputTokens = previousTokenWatermark;
    const activityLog: string[] = [];
    let lastStreamEventLabel = L("none", "없음");
    let progressDetail = L("Preparing request", "요청 준비 중");
    let latestDraftPreview: string | null = null;
    let codexAutoDecision: { path: string; reason?: string; model?: string; next?: string } | null = null;
    let codexAutoDecisionAnnounced = false;
    let lastLoggedStep = "";
    let lastGenericReasoningLogAt = 0;

    const normalizeProgressEntry = (value: string): string => value
      .replace(/\s+/g, " ")
      .replace(/^•\s*/, "")
      .trim()
      .toLowerCase();

    const pushActivityLog = (entry: string): void => {
      if (!entry.trim()) return;
      activityLog.push(entry);
      if (activityLog.length > 20) activityLog.shift(); // Increased from 12 to 20 (더 많은 단계 표시)
    };

    const isGenericFileEditEntry = (entry: string): boolean => (
      /^Editing file `[^`]+`$/.test(entry) || /^파일 편집 중 `[^`]+`$/.test(entry)
    );

    const isSpecificFileEditEntry = (entry: string): boolean => (
      (/^Editing .*[\\/].+/.test(entry) || /^.*[\\/].+ 수정 중$/.test(entry))
      && !isGenericFileEditEntry(entry)
    );

    const getEntryBasename = (entry: string): string | null => {
      const genericMatch = entry.match(/`([^`]+)`/);
      if (genericMatch) return genericMatch[1];
      const specificMatch = entry.match(/([A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?: 읽는 중| 수정 중)?$/);
      return specificMatch?.[1] ?? null;
    };

    const isGenericCommandEntry = (entry: string): boolean => (
      entry === L("Running command", "명령어 실행 중")
      || entry === L("Running shell command", "쉘 명령 실행 중")
    );

    const isSpecificCommandEntry = (entry: string): boolean => (
      entry.startsWith("Running command:")
      || entry.startsWith("명령 실행:")
    );

    const isInternalSystemEntry = (entry: string): boolean => {
      const normalized = normalizeProgressEntry(entry);
      return normalized === "system:task_started" || normalized === "task_started";
    };

    const isRedundantStatus = (status: string, current: string): boolean => {
      if (!status || !current) return false;
      const normalizedStatus = normalizeProgressEntry(status);
      const normalizedCurrent = normalizeProgressEntry(current);
      if (normalizedStatus === normalizedCurrent) return true;

      const statusBasename = getEntryBasename(status);
      const currentBasename = getEntryBasename(current);
      if (statusBasename && currentBasename && statusBasename === currentBasename) {
        if (isGenericFileEditEntry(status) && isSpecificFileEditEntry(current)) return true;
      }

      if (isGenericCommandEntry(status) && isSpecificCommandEntry(current)) return true;
      return false;
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

    const getDisplayActivityLog = (): string[] => {
      const genericEntries = new Set([
        L("Reasoning and planning", "추론 및 계획 중"),
        L("Generating reply text", "답변 텍스트 생성 중"),
        L("Session resumed", "세션 재개됨"),
      ]);
      const currentNormalized = normalizeProgressEntry(progressDetail);
      const items = activityLog.slice(-10);
      const hasSpecificCommand = items.some((item) => isSpecificCommandEntry(item));
      const specificEditBasenames = new Set(
        items
          .filter((item) => isSpecificFileEditEntry(item))
          .map((item) => getEntryBasename(item))
          .filter((value): value is string => Boolean(value)),
      );
      const filtered: string[] = [];
      const seen = new Set<string>();

      for (const item of items) {
        const normalized = normalizeProgressEntry(item);
        if (!normalized) continue;
        if (normalized === currentNormalized) continue;
        if (seen.has(normalized)) continue;
        if (isInternalSystemEntry(item)) continue;
        if (isGenericCommandEntry(item) && hasSpecificCommand) continue;
        if (isGenericFileEditEntry(item)) {
          const basename = getEntryBasename(item);
          if (basename && specificEditBasenames.has(basename)) continue;
        }

        const isGeneric = genericEntries.has(item);
        const hasSpecificAlready = filtered.length > 0;
        if (isGeneric && hasSpecificAlready) continue;

        seen.add(normalized);
        filtered.push(item);
      }

      return filtered.slice(-10); // Increased from 6 to 10 (더 많은 최근 단계 표시)
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

    const describeSystemStep = (subtype: string, message: Record<string, unknown>): string | null => {
      const detail = [
        typeof message.message === "string" ? message.message : null,
        typeof message.detail === "string" ? message.detail : null,
        typeof message.status === "string" ? message.status : null,
      ].find((value) => value && value.trim().length > 0) ?? null;

      if (subtype === "task_started") {
        return null;
      }
      if (subtype === "task_progress") {
        return detail
          ? L(`Progress: ${detail}`, `진행 중: ${detail}`)
          : L("Working through the task", "작업 단계를 진행 중");
      }
      if (subtype === "task_notification") {
        return detail
          ? L(`Update: ${detail}`, `업데이트: ${detail}`)
          : L("Task update received", "작업 업데이트 수신");
      }
      if (subtype === "init") {
        return null;
      }
      return detail
        ? L(`${subtype}: ${detail}`, `${subtype}: ${detail}`)
        : `system:${subtype}`;
    };

    const tightenEditInterval = (): void => {
      editSuccessStreak += 1;
      if (editSuccessStreak < 4) return;
      editSuccessStreak = 0;
      if (editInterval > MIN_EDIT_INTERVAL) {
        editInterval = Math.max(MIN_EDIT_INTERVAL, Math.floor(editInterval * 0.85));
      }
    };

    const loosenEditInterval = (): void => {
      editSuccessStreak = 0;
      editInterval = Math.min(MAX_EDIT_INTERVAL, Math.ceil(editInterval * 1.6));
    };

    const updateProgress = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastProgressEditTime < PROGRESS_EDIT_INTERVAL) return;
      lastProgressEditTime = now;

      const elapsedSec = Math.max(1, Math.floor((now - startTime) / 1000));
      const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      const spinner = spinnerFrames[progressTick % spinnerFrames.length];
      const recent = getDisplayActivityLog();
      const statusLine = isRedundantStatus(lastActivity, progressDetail)
        ? L("Tool work in progress", "도구 작업 진행 중")
        : lastActivity;
      const lines: string[] = [
        `• ${L("Session", "세션")}: ${sessionMode}`,
        `• ${L("Request", "요청")}: ${promptPreview || L("No prompt preview", "요청 미리보기 없음")}`,
        `• ${L("Status", "상태")}: ${statusLine}`,
        `• ${L("Tools", "도구")}: ${toolUseCount}`,
        `• ${L("Current", "현재 단계")}: ${progressDetail}`,
      ];
      if (codexAutoDecision) {
        const decisionModel = codexAutoDecision.model && codexAutoDecision.model !== "n/a"
          ? ` (${codexAutoDecision.model})`
          : "";
        lines.push(`• ${L("Codex auto path", "Codex 자동 경로")}: ${codexAutoDecision.path}${decisionModel}`);
      }
      if (latestDraftPreview) {
        lines.push(`• ${L("Latest draft", "최근 응답 초안")}: ${latestDraftPreview}`);
      }
      if (recent.length > 0) {
        lines.push(`• ${L("Recent steps", "최근 단계")}:`);
        for (const item of recent) lines.push(`• ${item}`);
      }
      if (hasTextOutput) {
        lines.push(`↳ ${L("Reply stream active", "답변 스트림 진행 중")}`);
      }
      lines.push(`${spinner} ${L("In progress", "진행 중")} (${elapsedSec}s)`);

      const body = lines.join("\n");
      const progressComponents = [createProgressControls(scopeId, this.getQueueSize(scopeId))];
      try {
        if (!progressMessage) {
          progressMessage = await sendToChannel({ content: body, components: progressComponents });
        } else {
          await progressMessage.edit({ content: body, components: progressComponents });
        }
      } catch (e) {
        console.warn(`[progress] Failed to update progress for ${scopeId}:`, e instanceof Error ? e.message : e);
      }
    };

    // Keep progress visibly alive even when no tool/text events arrive for a while.
    const progressInterval = setInterval(() => {
      progressTick++;
      updateProgress(true).catch(() => {});
    }, 2000);

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
      const promptWithContext = [
        buildGlobalOpsPrompt(),
        buildLocaleResponseHint(),
        !resumeSessionId && scopeId !== projectChannelId ? buildSkillIntro(selectedSkills) : null,
        !resumeSessionId && scopeId !== projectChannelId ? buildDefaultOpsHint() : null,
        prompt,
      ].filter(Boolean).join("\n\n");
      if (options?.preferFreshSession) {
        logStepIfChanged(L("Fast path enabled for short prompt", "짧은 요청용 빠른 경로 사용"));
      }
      if (useUltraFastMode) {
        logStepIfChanged(L("Ultra-fast mode enabled", "초고속 모드 사용"));
      }
      progressDetail = L("Request sent, waiting first response", "요청 전송됨, 첫 응답 대기 중");
      updateProgress(true).catch(() => {});

      const globalModel = getGlobalModel();
      const effectiveModel = dbSession?.model ?? project.model ?? globalModel ?? undefined;
      const ultraFastModel = useUltraFastMode
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
          settingSources: ["user", "project", "local"],
          ...(ultraFastModel ? { model: ultraFastModel } : {}),
          ...(useUltraFastMode ? { maxTurns: 1, promptSuggestions: false, agentProgressSummaries: false } : {}),
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
            const specificToolStep = describeToolStep(toolName, input);
            progressDetail = specificToolStep;
            logStepIfChanged(lastActivity);
            logStepIfChanged(specificToolStep);
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
              // Bash 도구: 명령어를 즉시 Discord에 미리보기 메시지로 전송
              if (toolName === "Bash" && typeof input.command === "string") {
                const command = input.command as string;
                const bashMsg = `⬦ \`bash Run\`\n\`\`\`bash\n${command}\n\`\`\``;
                await sendToChannel(bashMsg).catch(() => {});
              }
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
        stopped: false,
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
                  latestDraftPreview = preview;
                  logStepIfChanged(L(`Drafting: ${preview}`, `응답 작성: ${preview}`));
                }
              }
            }
          } else if (message.type === "system") {
            const subtype = ("subtype" in message && typeof message.subtype === "string") ? message.subtype : "event";
            lastStreamEventLabel = `system:${subtype}`;
            const noisy = ["hook_started", "hook_response", "status", "user"];
            if (!noisy.includes(subtype)) {
              const systemStep = describeSystemStep(subtype, message as Record<string, unknown>);
              if (systemStep) {
                progressDetail = systemStep;
                logStepIfChanged(systemStep);
              }
            }
            if (subtype === "compact_boundary") {
              sawCompactBoundary = true;
              const compactMsg = L(
                "Context compacted; next request will continue the same thread session",
                "컨텍스트 압축됨; 다음 요청도 같은 스레드 세션을 유지합니다",
              );
              progressDetail = compactMsg;
              logStepIfChanged(compactMsg);
            }
          } else if (message.type === "rate_limit_event") {
            lastStreamEventLabel = "rate_limit";
            const waitMsg = L("Anthropic rate limit, waiting to continue", "Anthropic rate limit 대기 중");
            progressDetail = waitMsg;
            logStepIfChanged(waitMsg);
            logStepIfChanged(L(
              "Next request will retry while keeping the same session",
              "다음 요청도 같은 세션을 유지한 채 재시도",
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
          this.scopeTokenWatermark.set(scopeId, maxInputTokens);
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
                    const slowMsg = L(
                      "Slow first token detected; keep current session and continue",
                      "첫 토큰 지연 감지; 현재 세션을 유지한 채 계속 진행",
                    );
                    progressDetail = slowMsg;
                    logStepIfChanged(slowMsg);
                  }
                }
              }
            }
          }
          const parsedCodexAutoDecision = extractCodexAutoDecision(responseBuffer);
          if (parsedCodexAutoDecision && !codexAutoDecision) {
            codexAutoDecision = parsedCodexAutoDecision;
            const decisionModel = parsedCodexAutoDecision.model && parsedCodexAutoDecision.model !== "n/a"
              ? ` (${parsedCodexAutoDecision.model})`
              : "";
            progressDetail = L(
              `Codex auto selected: ${parsedCodexAutoDecision.path}${decisionModel}`,
              `Codex 자동 선택: ${parsedCodexAutoDecision.path}${decisionModel}`,
            );
            logStepIfChanged(progressDetail);
          }
          if (parsedCodexAutoDecision && !codexAutoDecisionAnnounced) {
            codexAutoDecisionAnnounced = true;
            const decisionLines = [
              "Codex Auto Decision",
              `• Path: ${parsedCodexAutoDecision.path}`,
              ...(parsedCodexAutoDecision.reason ? [`• Reason: ${parsedCodexAutoDecision.reason}`] : []),
              ...(parsedCodexAutoDecision.model ? [`• Model: ${parsedCodexAutoDecision.model}`] : []),
              ...(parsedCodexAutoDecision.next ? [`• Next: ${parsedCodexAutoDecision.next}`] : []),
            ];
            await sendToChannel(decisionLines.join("\n"));
          }
          updateProgress().catch(() => {});

          const now = Date.now();
          if (now - lastEditTime >= editInterval && responseBuffer.length > 0) {
            lastEditTime = now;
            try {
              const liveText = formatStreamChunk(responseBuffer);
              if (!currentMessage) {
                currentMessage = await sendToChannel(liveText || "...");
              } else {
                await currentMessage.edit({ content: liveText || "..." });
              }
              tightenEditInterval();
            } catch (e) {
              loosenEditInterval();
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
          const conclusion = pickCheckpointConclusion(resultText, L("Task completed", "작업 완료"));
          const usageSummary = await getUsageSummaryLine();
          const activeInputSummary = maxInputTokens > 0
            ? `~${Math.max(1, Math.min(100, Math.round((maxInputTokens / 200_000) * 100)))}% (${maxInputTokens.toLocaleString()} tok)`
            : null;
          const continuitySummary = L(
            `resume=${resumeSessionId ? "yes" : "no"}, compacted=${sawCompactBoundary ? "yes" : "no"}`,
            `resume=${resumeSessionId ? "예" : "아니오"}, compacted=${sawCompactBoundary ? "예" : "아니오"}`,
          );
          const primarySkill = selectedSkills[0] ?? "none";
          const omcStatusLine = [
            `skill:${primarySkill}`,
            `agents:1`,
            `🔧${toolUseCount} 🤖1 ⚡${project.auto_approve ? 1 : 0}`,
            `model:${ultraFastModel ?? "default"}`,
          ].join(" | ");
          const completionSessionId = this.sessions.get(scopeId)?.sessionId ?? resumeSessionId ?? null;
          const completionCheckpoint = completionSessionId
            ? createCheckpoint(scopeId, projectChannelId, conclusion, undefined, completionSessionId)
            : null;
          if (completionCheckpoint) {
            const autoInsights = extractCheckpointInsights(resultText);
            if (autoInsights.length > 0) {
              addImprovements(completionCheckpoint.id, autoInsights);
              completionCheckpoint.improvements = autoInsights;
            }
          }
          const completionLines = [
            `✅ ${L("Task Complete", "작업 완료")}`,
            resultText,
            "",
            `\`${omcStatusLine}\``,
            ...(getDisplayActivityLog().length > 0
              ? [
                `${L("Recent Process", "최근 진행 과정")}:`,
                ...getDisplayActivityLog().map((line) => `• ${line}`),
              ]
              : []),
            ...(usageSummary ? usageSummary.split(" | ") : []),
            ...(codexAutoDecision
              ? [
                `${L("Codex auto decision", "Codex 자동 결정")} : ${codexAutoDecision.path}${codexAutoDecision.model && codexAutoDecision.model !== "n/a" ? ` (${codexAutoDecision.model})` : ""}`,
                ...(codexAutoDecision.reason ? [`${L("Decision reason", "선택 이유")} : ${codexAutoDecision.reason}`] : []),
                ...(codexAutoDecision.next ? [`${L("Next action", "다음 자동 행동")} : ${codexAutoDecision.next}`] : []),
              ]
              : []),
            `${L("Session continuity", "세션 연속성")} : ${continuitySummary}`,
            ...(activeInputSummary ? [`${L("Active input estimate", "활성 입력 추정치")} : ${activeInputSummary}`] : []),
            `${L("Duration", "소요 시간")} : ${(resultMsg.duration_ms / 1000).toFixed(1)}s`,
          ].filter(Boolean);
          const completionBody = completionLines.join("\n");
          const completionChunks = splitMessage(completionBody);
          if (completionChunks.length === 0) {
            await sendToChannel({
              content: L("✅ Task Complete", "✅ 작업 완료"),
              components: completionSessionId
                ? [
                  createProgressButtons({
                    checkpointId: completionCheckpoint?.id ?? "_",
                    hasCheckpoint: true,
                  }),
                ]
                : [],
            });
          } else {
            for (let i = 0; i < completionChunks.length; i++) {
              const isLast = i === completionChunks.length - 1;
              await sendToChannel({
                content: completionChunks[i],
                components: isLast && completionSessionId
                  ? [
                    createProgressButtons({
                      checkpointId: completionCheckpoint?.id ?? "_",
                      hasCheckpoint: true,
                    }),
                  ]
                  : [],
              });
            }
          }

          if (progressMessage) {
            const doneSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
            const doneLines = [
              `• ${L("Session", "세션")}: ${sessionMode}`,
              `• ${L("Request", "요청")}: ${promptPreview || L("No prompt preview", "요청 미리보기 없음")}`,
              `✅ ${L("Completed", "완료")}: ${conclusion}`,
              `• ${L("Tools", "도구")}: ${toolUseCount}`,
              `• ${L("Elapsed", "소요 시간")}: ${doneSec}s`,
            ];
            if (codexAutoDecision) {
              const decisionModel = codexAutoDecision.model && codexAutoDecision.model !== "n/a"
                ? ` (${codexAutoDecision.model})`
                : "";
              doneLines.push(`• ${L("Codex auto path", "Codex 자동 경로")}: ${codexAutoDecision.path}${decisionModel}`);
            }
            if (latestDraftPreview) {
              doneLines.push(`• ${L("Latest draft", "최근 응답 초안")}: ${latestDraftPreview}`);
            }
            const displayActivity = getDisplayActivityLog();
            if (displayActivity.length > 0) {
              doneLines.push(`• ${L("Process", "과정")}:`);
              for (const item of displayActivity) doneLines.push(`• ${item}`);
            }
            doneLines.push(`• ${L("Last event", "마지막 이벤트")}: ${lastStreamEventLabel}`);
            const doneProgressMessage = progressMessage as { edit: (v: any) => Promise<any>; delete?: () => Promise<any> } | null;
            await doneProgressMessage?.edit({
              content: doneLines.join("\n"),
              components: [],
            }).catch(() => {});
            setTimeout(() => {
              doneProgressMessage?.delete?.().catch(() => {});
            }, 10_000);
          }

          const resultAuthKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
          const lowerResult = resultText.toLowerCase();
          if (resultAuthKeywords.some((kw) => lowerResult.includes(kw))) {
            const restartDelaySeconds = 10;
            await sendToChannel(L(
              `🔑 Claude Code token expired. The bot will automatically restart in ${restartDelaySeconds} seconds to refresh the token.`,
              `🔑 Claude Code 토큰이 만료되었습니다. 봇이 ${restartDelaySeconds}초 뒤 자동으로 재시작되어 새 토큰을 로드합니다.`,
            ));
            // Auto-restart to refresh token
            setTimeout(() => {
              console.log(`[auth-token-restart] Restarting bot process to refresh Claude Code token...`);
              process.exit(1); // systemd/PM2/Task Scheduler will auto-restart
            }, restartDelaySeconds * 1000);
          }

          this.setStoredStatus(scopeId, projectChannelId, "idle");
          if (maxInputTokens > 0) this.scopeTokenWatermark.set(scopeId, maxInputTokens);
          hasResult = true;
        }
      }
    } catch (error) {
      const stoppedSession = this.sessions.get(scopeId);
      if (stoppedSession?.stopped) {
        this.setStoredStatus(scopeId, projectChannelId, "idle");
        hasResult = true;
        return;
      }
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
        const restartDelaySeconds = 10;
        errMsg += L(
          `\n\n🔑 Claude Code token expired. The bot will automatically restart in ${restartDelaySeconds} seconds to refresh the token.`,
          `\n\n🔑 Claude Code 토큰이 만료되었습니다. 봇이 ${restartDelaySeconds}초 뒤 자동으로 재시작되어 새 토큰을 로드합니다.`,
        );
        // Auto-restart to refresh token
        setTimeout(() => {
          console.log(`[auth-token-restart] Restarting bot process to refresh Claude Code token...`);
          process.exit(1); // systemd/PM2/Task Scheduler will auto-restart
        }, restartDelaySeconds * 1000);
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
          ? L(`📨 Processing queued message... (remaining: ${remaining})\n• Request: ${preview}`, `📨 대기 중이던 메시지를 처리합니다... (남은 큐: ${remaining}개)\n• 요청: ${preview}`)
          : L(`📨 Processing queued message...\n• Request: ${preview}`, `📨 대기 중이던 메시지를 처리합니다...\n• 요청: ${preview}`);
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
    session.stopped = true;

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

  setPendingManualCodex(scopeId: string, model: string, context: string): void {
    this.pendingManualCodex.set(scopeId, { model, context });
  }

  consumePendingManualCodex(scopeId: string): { model: string; context: string } | null {
    const value = this.pendingManualCodex.get(scopeId) ?? null;
    if (value) this.pendingManualCodex.delete(scopeId);
    return value;
  }

  hasPendingManualCodex(scopeId: string): boolean {
    return this.pendingManualCodex.has(scopeId);
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

  takePendingQueue(scopeId: string): { channel: TextChannel; prompt: string; sourceMessageId?: string } | null {
    const pending = this.pendingQueuePrompts.get(scopeId);
    if (!pending) return null;
    this.pendingQueuePrompts.delete(scopeId);
    return pending;
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
