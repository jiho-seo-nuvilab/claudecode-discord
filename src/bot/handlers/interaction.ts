import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type InteractionUpdateOptions,
  type MessageEditOptions,
  EmbedBuilder,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isAllowedUser } from "../../security/guard.js";
import { sessionManager } from "../../claude/session-manager.js";
import {
  upsertSession,
  getProject,
  getSession,
  getThreadSession,
  registerProject,
  getLatestThreadSession,
  upsertThreadSession,
  getProjectSkills,
  setProjectSkills,
  setProjectModel,
  setGlobalModel,
  setScopeModel,
} from "../../db/database.js";
import { findSessionDir, getLastAssistantMessage } from "../commands/sessions.js";
import { clearPendingRootPrompt, consumePendingRootPrompt } from "../thread-router.js";
import { L } from "../../utils/i18n.js";
import {
  DEFAULT_CODEX_MODEL,
  buildCodexAutoContinuePrompt,
  buildCodexCancelCommand,
  buildCodexRescueCommand,
  buildCodexResultCommand,
  buildCodexReviewCommand,
  buildCodexStatusCommand,
} from "../../utils/codex.js";
import { buildDefaultOpsHint, buildSkillIntro } from "../../utils/skills.js";
import {
  clearPickerQuery,
  createPickerFolder,
  getPickerDir,
  listPickerOptions,
  movePickerPage,
  movePickerUp,
  setPickerDir,
  setPickerQuery,
} from "../project-picker.js";
import {
  createProgressButtons,
  createProgressStatusMessage,
  splitLongMessage,
  createProgressEmbed,
  createReviewModeControls,
} from "../../claude/progress-buttons.js";
import {
  createCheckpoint,
  getLastCheckpoint,
  getAllCheckpoints,
  addImprovements,
  updateCheckpointStatus,
  getCheckpoint,
} from "../../claude/checkpoints.js";

function resumeStoredSession(
  scopeId: string,
  projectChannelId: string,
  sessionId: string,
  interaction: ButtonInteraction | ModalSubmitInteraction,
): void {
  const existing = getThreadSession(scopeId);
  const threadName =
    interaction.channel && interaction.channel.isThread() ? interaction.channel.name : null;

  if (scopeId === projectChannelId) {
    upsertSession(randomUUID(), projectChannelId, sessionId, "idle");
    return;
  }

  upsertThreadSession(
    scopeId,
    projectChannelId,
    sessionId,
    "idle",
    existing?.topic ?? threadName,
  );
}

function buildCodexContinueCommand(improvements: string[]): string {
  const body = improvements.length > 0
    ? `Continue from the just-completed point. First apply these improvements, then proceed with the next concrete implementation step:\n- ${improvements.join("\n- ")}`
    : "Continue from the just-completed point and take the next concrete implementation step.";
  return buildCodexRescueCommand(body);
}

function getProjectChannelIdFromInteraction(
  interaction: Pick<ButtonInteraction, "channelId" | "channel">,
): string {
  const channel = interaction.channel;
  if (channel && "isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    return channel.parentId ?? interaction.channelId;
  }
  return interaction.channelId;
}

function buildAutoReviewFocus(checkpoint: { description?: string; improvements?: string[] } | null): string {
  const parts: string[] = [];
  if (checkpoint?.description) {
    parts.push(`latest outcome: ${checkpoint.description}`);
  }
  const improvements = (checkpoint?.improvements ?? []).slice(0, 5);
  if (improvements.length > 0) {
    parts.push(`checkpoint insights: ${improvements.join(" | ")}`);
  }
  parts.push("challenge assumptions, race conditions, rollback safety, and whether a simpler approach exists");
  return parts.join(" / ");
}

function deriveEffectiveImprovements(
  scopeId: string,
  checkpoint: { id?: string; description?: string; improvements?: string[] } | null,
): string[] {
  const own = (checkpoint?.improvements ?? []).filter((item) => item.trim().length > 0);
  if (own.length > 0) return own.slice(0, 8);

  const fallback = getAllCheckpoints(scopeId)
    .filter((cp) => cp.id !== checkpoint?.id && (cp.improvements?.length ?? 0) > 0)
    .flatMap((cp) => cp.improvements ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (fallback.length > 0) return Array.from(new Set(fallback)).slice(0, 8);

  const description = checkpoint?.description?.trim();
  if (description) {
    return [
      L(
        `Continue from latest outcome: ${description}`,
        `최신 결과를 기준으로 이어서 진행: ${description}`,
      ),
    ];
  }

  return [
    L(
      "Use latest Reflection, Improvement, and Next Step Suggestion as the execution plan baseline.",
      "가장 최근 Reflection, Improvement, Next Step Suggestion을 실행 계획의 기본선으로 사용하세요.",
    ),
  ];
}

function extractCheckpointIdFromRequest(requestId: string): string {
  const direct = requestId.trim();
  const uuidMatch = direct.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (uuidMatch) return uuidMatch[1];
  return direct;
}

async function ensureEphemeralReply(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    console.log(`[button-ack] deferUpdate start ${interaction.customId}`);
    await interaction.deferUpdate();
    console.log(`[button-ack] deferUpdate ok ${interaction.customId}`);
  }
}

async function sendEphemeralButtonMessage(
  interaction: ButtonInteraction,
  payload: Parameters<ButtonInteraction["reply"]>[0],
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    console.log(`[button-reply] followUp ${interaction.customId}`);
    await interaction.followUp({ ...(payload as object), flags: ["Ephemeral"] });
    console.log(`[button-reply] followUp ok ${interaction.customId}`);
    return;
  }
  console.log(`[button-reply] reply ${interaction.customId}`);
  await interaction.reply({ ...(payload as object), flags: ["Ephemeral"] });
  console.log(`[button-reply] reply ok ${interaction.customId}`);
}

function buildProjectPickerView(channelId: string): InteractionUpdateOptions {
  const existing = getProject(channelId);
  const { rootDir, currentDir, options, page, totalPages, totalMatches, query } = listPickerOptions(channelId);

  if (options.length === 0) {
    return {
      content: L(`No folders found under \`${currentDir}\`.`, `\`${currentDir}\` 아래에 폴더가 없습니다.`),
      embeds: [],
      components: [],
    };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("project-select")
    .setPlaceholder(L("Choose a project folder", "프로젝트 폴더를 선택하세요"))
    .addOptions(options);

  return {
    embeds: [
      {
        title: L("Project Picker", "프로젝트 선택"),
        description: existing
          ? L(
            `Current project: \`${existing.project_path}\`\n\nBrowsing: \`${currentDir}\`\nRoot: \`${rootDir}\`\nMatches: ${totalMatches} · Page ${page + 1}/${totalPages}${query ? `\nSearch: \`${query}\`` : ""}`,
            `현재 프로젝트: \`${existing.project_path}\`\n\n현재 탐색 경로: \`${currentDir}\`\n루트: \`${rootDir}\`\n결과: ${totalMatches} · 페이지 ${page + 1}/${totalPages}${query ? `\n검색: \`${query}\`` : ""}`,
          )
          : L(
            `Select a project under \`${currentDir}\`.\nRoot: \`${rootDir}\`\nMatches: ${totalMatches} · Page ${page + 1}/${totalPages}${query ? `\nSearch: \`${query}\`` : ""}`,
            `\`${currentDir}\` 아래 프로젝트를 선택하세요.\n루트: \`${rootDir}\`\n결과: ${totalMatches} · 페이지 ${page + 1}/${totalPages}${query ? `\n검색: \`${query}\`` : ""}`,
          ),
        color: 0x5865f2,
      },
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("project-up:_")
          .setLabel(L("Up", "상위로"))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(path.resolve(currentDir) === path.resolve(rootDir)),
        new ButtonBuilder()
          .setCustomId("project-prev:_")
          .setLabel(L("Prev", "이전"))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId("project-next:_")
          .setLabel(L("Next", "다음"))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1),
        new ButtonBuilder()
          .setCustomId("project-refresh:_")
          .setLabel(L("Refresh", "새로고침"))
          .setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("project-search:_")
          .setLabel(L("Search", "검색"))
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("project-clear-search:_")
          .setLabel(L("Clear Search", "검색 해제"))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!query),
        new ButtonBuilder()
          .setCustomId("project-create:_")
          .setLabel(L("New Folder", "새 폴더"))
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

async function showProjectPicker(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  await interaction.update(buildProjectPickerView(interaction.channelId));
}

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  console.log(`[handleButtonInteraction] customId=${interaction.customId}`);
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  const customId = interaction.customId;
  const colonIndex = customId.indexOf(":");
  const action = colonIndex === -1 ? customId : customId.slice(0, colonIndex);
  const requestId = colonIndex === -1 ? "" : customId.slice(colonIndex + 1);

  if (action === "project-refresh") {
    await showProjectPicker(interaction);
    return;
  }

  if (action === "project-up") {
    movePickerUp(interaction.channelId);
    await showProjectPicker(interaction);
    return;
  }

  if (action === "project-prev") {
    movePickerPage(interaction.channelId, -1);
    await showProjectPicker(interaction);
    return;
  }

  if (action === "project-next") {
    movePickerPage(interaction.channelId, 1);
    await showProjectPicker(interaction);
    return;
  }

  if (action === "project-clear-search") {
    clearPickerQuery(interaction.channelId);
    await showProjectPicker(interaction);
    return;
  }

  if (action === "project-search") {
    const modal = new ModalBuilder()
      .setCustomId("project-search-modal")
      .setTitle(L("Search Projects", "프로젝트 검색"));
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("query")
          .setLabel(L("Folder name contains", "폴더 이름 검색"))
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder(L("android, api, server...", "android, api, server...")),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "project-create") {
    const modal = new ModalBuilder()
      .setCustomId("project-create-modal")
      .setTitle(L("Create Folder", "폴더 생성"));
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("folder")
          .setLabel(L("New folder name", "새 폴더 이름"))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(L("my-new-project", "my-new-project")),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "model-apply-channel") {
    setProjectModel(requestId.split(":")[0], requestId.split(":").slice(1).join(":"));
    await interaction.update({
      content: L("Channel model updated.", "채널 모델을 변경했습니다."),
      components: [],
    });
    return;
  }

  if (action === "model-apply-global") {
    setGlobalModel(requestId);
    await interaction.update({
      content: L("Global model updated.", "전역 모델을 변경했습니다."),
      components: [],
    });
    return;
  }

  if (action === "model-apply-session") {
    const [projectChannelId, scopeId, ...modelParts] = requestId.split(":");
    const model = modelParts.join(":");
    setScopeModel(scopeId, projectChannelId, model === "__default__" ? null : model);
    await interaction.update({
      content: model === "__default__"
        ? L("Session model reset to inherited default.", "세션 모델을 상속 기본값으로 초기화했습니다.")
        : L(`Session model updated to \`${model}\`.`, `세션 모델을 \`${model}\`(으)로 변경했습니다.`),
      components: [],
    });
    return;
  }

  if (action === "model-reset-global") {
    setGlobalModel(null);
    await interaction.update({
      content: L("Global model reset.", "전역 모델을 초기화했습니다."),
      components: [],
    });
    return;
  }

  if (action === "model-reset-scope") {
    const [projectChannelId, scopeId] = requestId.split(":");
    setScopeModel(scopeId, projectChannelId, null);
    await interaction.update({
      content: L("Session model reset.", "세션 모델을 초기화했습니다."),
      components: [],
    });
    return;
  }

  if (action === "project-new-thread") {
    const [channelId, sourceMessageId] = requestId.split(":");
    const pending = consumePendingRootPrompt(channelId);
    if (!pending || pending.sourceMessageId !== sourceMessageId) {
      await interaction.update({
        content: L("This prompt is no longer pending. Send it again.", "이 요청은 이미 처리되었어요. 다시 보내주세요."),
        embeds: [],
        components: [],
      });
      return;
    }

    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.update({
        content: L("This action must be used in a text channel.", "이 작업은 텍스트 채널에서만 사용할 수 있습니다."),
        embeds: [],
        components: [],
      });
      return;
    }

    const sourceMessage = await interaction.channel.messages.fetch(sourceMessageId).catch(() => null);
    if (!sourceMessage) {
      await interaction.update({
        content: L("Could not find the original message.", "원본 메시지를 찾지 못했습니다."),
        embeds: [],
        components: [],
      });
      return;
    }

    const title = (pending.prompt.split("\n")[0].trim() || L("New topic", "새 주제")).slice(0, 80);
    const thread = await sourceMessage.startThread({
      name: title,
      autoArchiveDuration: 1440,
    });

    upsertThreadSession(thread.id, channelId, null, "idle", title);
    const project = getProject(channelId);
    const selectedSkills = project?.skills ? project.skills.split(",").map((skill) => skill.trim()).filter(Boolean) : [];
    await interaction.update({
      content: L(`Thread created: <#${thread.id}>`, `스레드 생성됨: <#${thread.id}>`),
      components: [],
    });
    const starter = await thread.send(
      [
        L(`Starting new topic:\n> ${pending.prompt}`, `새 주제를 시작합니다:\n> ${pending.prompt}`),
        buildSkillIntro(selectedSkills),
        buildDefaultOpsHint(),
      ].filter(Boolean).join("\n\n"),
    );
    await sessionManager.sendMessage(thread as any, pending.prompt, {
      scopeId: thread.id,
      projectChannelId: channelId,
      topic: title,
      sourceMessageId: starter.id,
    });
    return;
  }

  if (action === "project-continue-thread") {
    const [channelId, sourceMessageId, ...threadParts] = requestId.split(":");
    const threadId = threadParts.join(":");
    const pending = consumePendingRootPrompt(channelId);
    if (!pending || pending.sourceMessageId !== sourceMessageId) {
      await interaction.update({
        content: L("This prompt is no longer pending. Send it again.", "이 요청은 이미 처리되었어요. 다시 보내주세요."),
        embeds: [],
        components: [],
      });
      return;
    }

    const threadChannel = await interaction.client.channels.fetch(threadId).catch(() => null);
    if (!threadChannel || !threadChannel.isThread()) {
      await interaction.update({
        content: L("Could not find the recent thread. Start a new thread instead.", "최근 스레드를 찾지 못했습니다. 새 스레드를 시작해 주세요."),
        embeds: [],
        components: [],
      });
      return;
    }

    if (threadChannel.archived) {
      await threadChannel.setArchived(false);
    }

    const latest = getLatestThreadSession(channelId);
    const project = getProject(channelId);
    const selectedSkills = project?.skills ? project.skills.split(",").map((skill) => skill.trim()).filter(Boolean) : [];
    await interaction.update({
      content: L(`Continuing in <#${threadChannel.id}>`, `<#${threadChannel.id}> 에서 이어갑니다.`),
      components: [],
    });
    const continuation = await threadChannel.send(
      [
        L(`Continuing topic:\n> ${pending.prompt}`, `주제를 이어갑니다:\n> ${pending.prompt}`),
        buildSkillIntro(selectedSkills),
      ].filter(Boolean).join("\n\n"),
    );
    await sessionManager.sendMessage(threadChannel as any, pending.prompt, {
      scopeId: threadChannel.id,
      projectChannelId: channelId,
      topic: latest?.topic ?? threadChannel.name,
      sourceMessageId: continuation.id,
    });
    return;
  }

  if (!requestId) {
    await interaction.reply({
      content: L("Invalid button interaction.", "잘못된 버튼 상호작용입니다."),
      ephemeral: true,
    });
    return;
  }

  if (action === "stop") {
    const stopped = await sessionManager.stopSession(requestId);
    await interaction.update({
      content: L("⏹️ Task has been stopped.", "⏹️ 작업이 중지되었습니다."),
      components: [],
    });
    if (!stopped) {
      await interaction.followUp({
        content: L("No active session.", "활성 세션이 없습니다."),
        ephemeral: true,
      });
    }
    return;
  }

  if (action === "queue-yes") {
    const confirmed = sessionManager.confirmQueue(requestId);
    if (!confirmed) {
      await interaction.update({
        content: L("⏳ Queue request has expired.", "⏳ 큐 요청이 만료되었습니다."),
        components: [],
      });
      return;
    }
    const queueSize = sessionManager.getQueueSize(requestId);
    await interaction.update({
      content: L(
        `📨 Message added to queue (${queueSize}/5). It will be processed after the current task.\n• You can use /cc-status to see live progress.`,
        `📨 메시지가 큐에 추가되었습니다 (${queueSize}/5). 이전 작업 완료 후 자동으로 처리됩니다.\n• /cc-status 로 현재 진행 상황을 볼 수 있습니다.`,
      ),
      components: [],
    });
    return;
  }

  if (action === "queue-now") {
    const pending = sessionManager.takePendingQueue(requestId);
    if (!pending) {
      await interaction.update({
        content: L("⏳ Queue request has expired.", "⏳ 큐 요청이 만료되었습니다."),
        components: [],
      });
      return;
    }

    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const sessionRecord = requestId === projectChannelId ? getSession(projectChannelId) : getThreadSession(requestId);
    const resumeSessionId = sessionRecord?.session_id ?? undefined;
    const interruptCheckpoint = resumeSessionId
      ? createCheckpoint(
        requestId,
        projectChannelId,
        L(
          "Interrupted by Stop & Run Now before completion.",
          "완료 전 '중지 후 바로 실행'으로 중단됨.",
        ),
        undefined,
        resumeSessionId,
      )
      : null;
    if (interruptCheckpoint) {
      addImprovements(interruptCheckpoint.id, [
        L(
          `Queued request triggered interruption: ${pending.prompt.slice(0, 120)}`,
          `대기 요청으로 중단됨: ${pending.prompt.slice(0, 120)}`,
        ),
      ]);
      updateCheckpointStatus(interruptCheckpoint.id, "reviewed");
    }
    await sessionManager.stopSession(requestId);

    await interaction.update({
      content: L(
        "⏹️ Stopped current task and saved an interrupt checkpoint. Running your new request now.",
        "⏹️ 현재 작업을 중지하고 중단 체크포인트를 저장했습니다. 새 요청을 바로 실행합니다.",
      ),
      components: [],
    });

    await sessionManager.sendMessage(pending.channel, pending.prompt, {
      scopeId: requestId,
      projectChannelId,
      topic: interaction.channel && interaction.channel.isThread() ? interaction.channel.name : null,
      preferFreshSession: true,
      sourceMessageId: pending.sourceMessageId,
    });
    return;
  }

  if (action === "queue-btw") {
    const pending = sessionManager.takePendingQueue(requestId);
    if (!pending) {
      await interaction.update({
        content: L("⏳ Queue request has expired.", "⏳ 큐 요청이 만료되었습니다."),
        components: [],
      });
      return;
    }

    const btwPrompt = `[BTW side question]\n${pending.prompt}`;
    if (sessionManager.isActive(requestId)) {
      const queued = sessionManager.enqueueMessage(requestId, pending.channel, btwPrompt, pending.sourceMessageId);
      if (!queued) {
        await interaction.update({
          content: L("Queue is full (max 5). Please wait for current tasks to finish.", "큐가 가득 찼습니다 (최대 5개). 현재 작업 완료 후 다시 시도해 주세요."),
          components: [],
        });
        return;
      }
      await interaction.update({
        content: L(
          `💬 Queued as BTW (${sessionManager.getQueueSize(requestId)}/5).`,
          `💬 BTW로 큐에 추가했습니다 (${sessionManager.getQueueSize(requestId)}/5).`,
        ),
        components: [],
      });
      return;
    }

    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    await interaction.update({
      content: L("No active task now. Sending BTW immediately.", "현재 활성 작업이 없어 BTW를 바로 전송합니다."),
      components: [],
    });
    await sessionManager.sendMessage(pending.channel, btwPrompt, {
      scopeId: requestId,
      projectChannelId,
      topic: interaction.channel && interaction.channel.isThread() ? interaction.channel.name : null,
      sourceMessageId: pending.sourceMessageId,
    });
    return;
  }

  if (action === "queue-no") {
    sessionManager.cancelQueue(requestId);
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      components: [],
    });
    return;
  }

  if (action === "session-resume") {
    const sessionId = requestId;
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const project = getProject(projectChannelId);
    if (!project) {
      await interaction.update({
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        components: [],
      });
      return;
    }
    resumeStoredSession(scopeId, projectChannelId, sessionId, interaction);

    await interaction.update({
      embeds: [
        {
          title: L("Session Resumed", "세션 재개됨"),
          description: L(
            `Session: \`${sessionId.slice(0, 8)}...\`\n\nNext message you send will continue from that completed point.`,
            `세션: \`${sessionId.slice(0, 8)}...\`\n\n다음 메시지부터 해당 완료 시점에서 이어집니다.`,
          ),
          color: 0x00ff00,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "checkpoint-resume") {
    await ensureEphemeralReply(interaction);
    const checkpoint = getCheckpoint(extractCheckpointIdFromRequest(requestId));
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    if (!checkpoint?.resumeSessionId) {
      await sendEphemeralButtonMessage(interaction, {
        content: L("Saved checkpoint session was not found.", "저장된 체크포인트 세션을 찾지 못했습니다."),
        components: [],
      });
      return;
    }
    resumeStoredSession(scopeId, projectChannelId, checkpoint.resumeSessionId, interaction);
    await sendEphemeralButtonMessage(interaction, {
      embeds: [
        {
          title: L("Session Resumed", "세션 재개됨"),
          description: L(
            `Session: \`${checkpoint.resumeSessionId.slice(0, 8)}...\`\n\nNext message you send will continue from that completed point.`,
            `세션: \`${checkpoint.resumeSessionId.slice(0, 8)}...\`\n\n다음 메시지부터 해당 완료 시점에서 이어집니다.`,
          ),
          color: 0x00ff00,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "session-cancel") {
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "ask-opt") {
    const lastColon = requestId.lastIndexOf(":");
    const actualRequestId = requestId.slice(0, lastColon);
    const selectedLabel = ("label" in interaction.component ? interaction.component.label : null) ?? "Unknown";

    const resolved = sessionManager.resolveQuestion(actualRequestId, selectedLabel);
    if (!resolved) {
      await interaction.reply({ content: L("This question has expired.", "이 질문은 만료되었습니다."), ephemeral: true });
      return;
    }

    await interaction.update({
      content: L(`✅ Selected: **${selectedLabel}**`, `✅ 선택됨: **${selectedLabel}**`),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "ask-other") {
    sessionManager.enableCustomInput(requestId, interaction.channelId);
    await interaction.update({
      content: L("✏️ Type your answer...", "✏️ 답변을 입력하세요..."),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "queue-clear") {
    const cleared = sessionManager.clearQueue(requestId);
    await interaction.update({
      embeds: [
        {
          title: L("Queue Cleared", "큐 초기화됨"),
          description: L(`Cleared ${cleared} queued message(s).`, `${cleared}개의 대기 중이던 메시지를 취소했습니다.`),
          color: 0xff6600,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "progress-queue-clear") {
    const cleared = sessionManager.clearQueue(requestId);
    await interaction.reply({
      content: cleared > 0
        ? L(
          `🧹 Cleared ${cleared} queued message(s). Current task keeps running.`,
          `🧹 대기 중이던 메시지 ${cleared}개를 정리했습니다. 현재 작업은 계속 진행됩니다.`,
        )
        : L(
          "🧹 Queue is already empty. Current task keeps running.",
          "🧹 이미 큐가 비어 있습니다. 현재 작업은 계속 진행됩니다.",
        ),
      ephemeral: true,
    });
    return;
  }

  if (action === "queue-remove") {
    const lastColon = requestId.lastIndexOf(":");
    const scopeId = requestId.slice(0, lastColon);
    const index = parseInt(requestId.slice(lastColon + 1), 10);
    const removed = sessionManager.removeFromQueue(scopeId, index);

    if (!removed) {
      await interaction.update({
        content: L("This item is no longer in the queue.", "이 항목은 이미 큐에 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }

    const preview = removed.length > 60 ? removed.slice(0, 60) + "…" : removed;
    const queue = sessionManager.getQueue(scopeId);
    if (queue.length === 0) {
      await interaction.update({
        embeds: [
          {
            title: L("Message Removed", "메시지 취소됨"),
            description: L(`Removed: ${preview}\n\nQueue is now empty.`, `취소됨: ${preview}\n\n큐가 비었습니다.`),
            color: 0xff6600,
          },
        ],
        components: [],
      });
      return;
    }

    const list = queue
      .map((item, idx) => {
        const p = item.prompt.length > 100 ? item.prompt.slice(0, 100) + "…" : item.prompt;
        return `**${idx + 1}.** ${p}`;
      })
      .join("\n\n");

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const itemButtons = queue.map((_, idx) =>
      new ButtonBuilder()
        .setCustomId(`queue-remove:${scopeId}:${idx}`)
        .setLabel(`❌ ${idx + 1}`)
        .setStyle(ButtonStyle.Secondary),
    );
    const clearButton = new ButtonBuilder()
      .setCustomId(`queue-clear:${scopeId}`)
      .setLabel(L("Clear All", "모두 취소"))
      .setStyle(ButtonStyle.Danger);

    const allButtons = [...itemButtons.slice(0, 19), clearButton];
    for (let i = 0; i < allButtons.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...allButtons.slice(i, i + 5)));
    }

    await interaction.update({
      embeds: [
        {
          title: L(`📋 Message Queue (${queue.length})`, `📋 메시지 큐 (${queue.length}개)`),
          description: `~~${preview}~~ ${L("removed", "취소됨")}\n\n${list}`,
          color: 0x5865f2,
        },
      ],
      components: rows,
    });
    return;
  }

  if (action === "progress-back") {
    await ensureEphemeralReply(interaction);
    const checkpointId = extractCheckpointIdFromRequest(requestId);
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);

    if (!checkpoint?.resumeSessionId) {
      await sendEphemeralButtonMessage(interaction, {
        content: L("No checkpoint available.", "복구할 체크포인트가 없습니다."),
        components: [],
      });
      return;
    }

    updateCheckpointStatus(checkpoint.id, "applied");
    const resumeSessionId = checkpoint.resumeSessionId;
    resumeStoredSession(scopeId, projectChannelId, resumeSessionId, interaction);

    await sendEphemeralButtonMessage(interaction, {
      embeds: [
        {
          title: L("Returned to Saved Point", "저장된 시점으로 돌아감"),
          description: L(
            `Session: \`${resumeSessionId.slice(0, 8)}...\`\n\nNext message will continue from that saved point.`,
            `세션: \`${resumeSessionId.slice(0, 8)}...\`\n\n다음 메시지부터 해당 저장 시점에서 이어집니다.`,
          ),
          color: 0x57f287,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "progress-next-claude") {
    await ensureEphemeralReply(interaction);
    const checkpointId = extractCheckpointIdFromRequest(requestId);
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);
    const project = getProject(projectChannelId);
    if (!project) {
      await sendEphemeralButtonMessage(interaction, {
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        components: [],
      });
      return;
    }

    if (checkpoint) {
      updateCheckpointStatus(checkpoint.id, "applied");
    }
    if (checkpoint?.resumeSessionId) {
      resumeStoredSession(scopeId, projectChannelId, checkpoint.resumeSessionId, interaction);
    }

    const effectiveImprovements = deriveEffectiveImprovements(scopeId, checkpoint);
    const checkpointForDisplay = checkpoint
      ? { ...checkpoint, improvements: effectiveImprovements }
      : null;
    const response = createProgressStatusMessage(scopeId, "next", checkpointForDisplay as any);
    await sendEphemeralButtonMessage(interaction, response);

    const continuePrompt = effectiveImprovements.length > 0
      ? L(
        `Continue from the just-completed point. Apply these review improvements first, then keep moving autonomously:\n- ${effectiveImprovements.join("\n- ")}\n\nAlways end your response with [Reflection], [Improvement], [Next Step Suggestion].`,
        `방금 완료된 지점부터 이어서 진행하세요. 먼저 아래 리뷰 개선점을 반영하고, 그다음 다음 단계까지 자율적으로 계속 진행하세요:\n- ${effectiveImprovements.join("\n- ")}\n\n응답 마지막에는 항상 [Reflection], [Improvement], [Next Step Suggestion]을 포함하세요.`,
      )
      : L(
        "Continue from the just-completed point and take the next concrete implementation step autonomously. Report progress as you work. Always end your response with [Reflection], [Improvement], [Next Step Suggestion].",
        "방금 완료된 지점부터 이어서, 다음 구체적인 구현 단계를 자율적으로 진행하세요. 진행 중에는 중간 과정을 계속 보고하세요. 응답 마지막에는 항상 [Reflection], [Improvement], [Next Step Suggestion]을 포함하세요.",
      );

    await sessionManager.sendMessage(interaction.channel as any, continuePrompt, {
      scopeId,
      projectChannelId,
    });
    return;
  }

  if (action === "progress-next-codex") {
    await ensureEphemeralReply(interaction);
    const checkpointId = extractCheckpointIdFromRequest(requestId);
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);
    const project = getProject(projectChannelId);
    if (!project) {
      await sendEphemeralButtonMessage(interaction, {
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        components: [],
      });
      return;
    }
    if (checkpoint) {
      updateCheckpointStatus(checkpoint.id, "applied");
    }
    if (checkpoint?.resumeSessionId) {
      resumeStoredSession(scopeId, projectChannelId, checkpoint.resumeSessionId, interaction);
    }
    const effectiveImprovements = deriveEffectiveImprovements(scopeId, checkpoint);
    const autoPrompt = buildCodexAutoContinuePrompt({
      description: checkpoint?.description,
      improvements: effectiveImprovements,
      model: DEFAULT_CODEX_MODEL,
    });
    await sendEphemeralButtonMessage(interaction, {
      content: L(
        `Codex auto-continue is starting.\nIt will inspect current Codex state first, choose status/result/resume/rescue automatically, and explicitly report the chosen path.\nDefault model: \`${DEFAULT_CODEX_MODEL}\``,
        `Codex 자동 이어가기를 시작합니다.\n먼저 현재 Codex 상태를 점검한 뒤 status/result/resume/rescue 중 적절한 경로를 자동 선택하고, 어떤 경로를 골랐는지 먼저 명시적으로 보고합니다.\n기본 모델: \`${DEFAULT_CODEX_MODEL}\``,
      ),
      components: [],
    });

    await sessionManager.sendMessage(interaction.channel as any, autoPrompt, {
      scopeId,
      projectChannelId,
    });
    return;
  }

  if (action === "progress-codex-rescue" || action === "progress-codex-status" || action === "progress-codex-result" || action === "progress-codex-cancel") {
    await ensureEphemeralReply(interaction);
    const checkpointId = extractCheckpointIdFromRequest(requestId);
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);
    const project = getProject(projectChannelId);
    if (!project) {
      await sendEphemeralButtonMessage(interaction, {
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        components: [],
      });
      return;
    }

    if (checkpoint?.resumeSessionId) {
      resumeStoredSession(scopeId, projectChannelId, checkpoint.resumeSessionId, interaction);
    }

    let command = "";
    let notice = "";
    if (action === "progress-codex-rescue") {
      if (checkpoint) updateCheckpointStatus(checkpoint.id, "applied");
      const effectiveImprovements = deriveEffectiveImprovements(scopeId, checkpoint);
      command = buildCodexContinueCommand(effectiveImprovements);
      notice = L(
        `Delegating continuation to Codex.\n\`${command}\``,
        `이어지는 작업을 Codex에게 위임합니다.\n\`${command}\``,
      );
    } else if (action === "progress-codex-status") {
      command = buildCodexStatusCommand();
      notice = L(
        `Checking Codex background task status.\n\`${command}\``,
        `Codex 백그라운드 작업 상태를 확인합니다.\n\`${command}\``,
      );
    } else if (action === "progress-codex-result") {
      command = buildCodexResultCommand();
      notice = L(
        `Fetching the latest Codex result.\n\`${command}\`\nUse the returned session id with \`codex resume <id>\` when you want direct Codex resume.`,
        `최신 Codex 결과를 가져옵니다.\n\`${command}\`\n직접 Codex 재개가 필요하면 반환된 session id로 \`codex resume <id>\`를 사용하세요.`,
      );
    } else {
      command = buildCodexCancelCommand();
      notice = L(
        `Cancelling the active Codex task.\n\`${command}\``,
        `현재 Codex 작업을 취소합니다.\n\`${command}\``,
      );
    }

    await sendEphemeralButtonMessage(interaction, {
      content: notice,
      components: [],
    });

    await sessionManager.sendMessage(interaction.channel as any, command, {
      scopeId,
      projectChannelId,
    });
    return;
  }

  if (action === "progress-review") {
    await ensureEphemeralReply(interaction);
    const checkpointId = extractCheckpointIdFromRequest(requestId);
    const scopeId = interaction.channelId;
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);
    await sendEphemeralButtonMessage(interaction, {
      content: L(
        `Choose the Codex review mode.\n• Normal review runs \`/codex:review --background --model ${DEFAULT_CODEX_MODEL}\`\n• Adversarial review auto-builds \`--base main\`, applies \`--model ${DEFAULT_CODEX_MODEL}\`, and uses challenge focus from the latest checkpoint`,
        `Codex 리뷰 모드를 선택하세요.\n• 일반 리뷰는 \`/codex:review --background --model ${DEFAULT_CODEX_MODEL}\`로 실행합니다\n• Adversarial 리뷰는 최근 체크포인트(회고/개선점/다음 단계) 기반으로 \`--base main\`과 \`--model ${DEFAULT_CODEX_MODEL}\`을 자동 적용합니다`,
      ),
      components: [createReviewModeControls(checkpoint?.id ?? checkpointId ?? "_")],
      ephemeral: true,
    });
    return;
  }

  if (action === "progress-review-normal") {
    await ensureEphemeralReply(interaction);
    const checkpointId = extractCheckpointIdFromRequest(requestId);
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);
    const project = getProject(projectChannelId);
    if (!project) {
      await sendEphemeralButtonMessage(interaction, {
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        components: [],
      });
      return;
    }

    if (checkpoint) {
      updateCheckpointStatus(checkpoint.id, "reviewed");
      addImprovements(checkpoint.id, [buildCodexReviewCommand("normal")]);
    }
    if (checkpoint?.resumeSessionId) {
      resumeStoredSession(scopeId, projectChannelId, checkpoint.resumeSessionId, interaction);
    }
    const command = buildCodexReviewCommand("normal");

    await sendEphemeralButtonMessage(interaction, {
      content: L(
        `Starting Codex review in background.\n\`${command}\``,
        `Codex 일반 리뷰를 백그라운드로 시작합니다.\n\`${command}\``,
      ),
      components: [],
    });

    await sessionManager.sendMessage(interaction.channel as any, command, {
      scopeId,
      projectChannelId,
    });
    return;
  }

  if (action === "progress-review-adversarial") {
    await ensureEphemeralReply(interaction);
    const checkpointId = extractCheckpointIdFromRequest(requestId);
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction);
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);
    const project = getProject(projectChannelId);
    if (!project) {
      await sendEphemeralButtonMessage(interaction, {
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        components: [],
      });
      return;
    }
    if (checkpoint) {
      updateCheckpointStatus(checkpoint.id, "reviewed");
    }
    if (checkpoint?.resumeSessionId) {
      resumeStoredSession(scopeId, projectChannelId, checkpoint.resumeSessionId, interaction);
    }

    const effectiveImprovements = deriveEffectiveImprovements(scopeId, checkpoint);
    const autoFocus = buildAutoReviewFocus(
      checkpoint ? { ...checkpoint, improvements: effectiveImprovements } : { improvements: effectiveImprovements },
    );
    const command = buildCodexReviewCommand("adversarial", "main", autoFocus);

    await sendEphemeralButtonMessage(interaction, {
      content: L(
        `Starting Codex adversarial review in background (auto-filled from latest checkpoint).\n\`${command}\``,
        `최근 체크포인트 기준으로 자동 채운 Codex adversarial 리뷰를 백그라운드로 시작합니다.\n\`${command}\``,
      ),
      components: [],
    });

    await sessionManager.sendMessage(interaction.channel as any, command, {
      scopeId,
      projectChannelId,
    });
    return;
  }

  if (action === "session-delete") {
    const sessionId = requestId;
    const channelId = interaction.channelId;
    const project = getProject(channelId);
    if (!project) {
      await interaction.update({
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }

    const sessionDir = findSessionDir(project.project_path);
    if (sessionDir) {
      const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
      try {
        fs.unlinkSync(filePath);
        const dbSession = getSession(channelId);
        if (dbSession?.session_id === sessionId) {
          const { randomUUID } = await import("node:crypto");
          upsertSession(randomUUID(), channelId, null, "idle");
        }
        await interaction.update({
          embeds: [
            {
              title: L("Session Deleted", "세션 삭제됨"),
              description: L(
                `Session \`${sessionId.slice(0, 8)}...\` has been deleted.\nYour next message will start a new conversation.`,
                `세션 \`${sessionId.slice(0, 8)}...\`이(가) 삭제되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다.`,
              ),
              color: 0xff6b6b,
            },
          ],
          components: [],
        });
      } catch {
        await interaction.update({
          content: L("Failed to delete session file.", "세션 파일 삭제에 실패했습니다."),
          embeds: [],
          components: [],
        });
      }
    }
    return;
  }

  let decision: "approve" | "deny" | "approve-all";
  if (action === "approve") {
    decision = "approve";
  } else if (action === "deny") {
    decision = "deny";
  } else if (action === "approve-all") {
    decision = "approve-all";
  } else {
    return;
  }

  const resolved = sessionManager.resolveApproval(requestId, decision);
  if (!resolved) {
    await interaction.reply({
      content: L("This approval request has expired.", "이 승인 요청은 만료되었습니다."),
      ephemeral: true,
    });
    return;
  }

  const labels: Record<string, string> = {
    approve: L("✅ Approved", "✅ 승인됨"),
    deny: L("❌ Denied", "❌ 거부됨"),
    "approve-all": L("⚡ Auto-approve enabled for this channel", "⚡ 이 채널에서 자동 승인이 활성화되었습니다"),
  };

  await interaction.update({
    content: labels[decision],
    components: [],
  });
}

export async function handleSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === "project-select") {
    const selected = interaction.values[0];
    const currentDir = getPickerDir(interaction.channelId);
    const projectPath = selected === "."
      ? currentDir
      : path.join(currentDir, selected);
    setPickerDir(interaction.channelId, path.dirname(projectPath));
    registerProject(interaction.channelId, projectPath, interaction.guildId!);
    clearPendingRootPrompt(interaction.channelId);
    await interaction.update({
      embeds: [
        {
          title: L("Project Registered", "프로젝트 등록됨"),
          description: L(`This channel is now linked to:\n\`${projectPath}\``, `이 채널이 연결되었습니다:\n\`${projectPath}\``),
          color: 0x00ff00,
        },
      ],
      components: [],
    });
    return;
  }

  if (interaction.customId.startsWith("model-select:")) {
    const [, projectChannelId, scopeId] = interaction.customId.split(":");
    const selected = interaction.values[0];
    await interaction.update({
      content: selected === "__default__"
        ? L("Choose where to reset model.", "어디에 모델 초기화를 적용할지 선택하세요.")
        : L(`Selected model: \`${selected}\`\nChoose where to apply it.`, `선택한 모델: \`${selected}\`\n적용 범위를 선택하세요.`),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`model-apply-channel:${projectChannelId}:${selected}`)
            .setLabel(L("Apply to channel", "채널에 적용"))
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`model-apply-session:${projectChannelId}:${scopeId}:${selected}`)
            .setLabel(L("Apply to current session", "현재 세션에 적용"))
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`model-apply-global:${selected}`)
            .setLabel(L("Apply globally", "전역에 적용"))
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (interaction.customId.startsWith("skills-select:")) {
    const [, mode, projectChannelId] = interaction.customId.split(":");
    const current = getProjectSkills(projectChannelId);
    const selected = interaction.values;
    const next = mode === "remove"
      ? current.filter((skill) => !selected.includes(skill))
      : Array.from(new Set([...current, ...selected]));
    setProjectSkills(projectChannelId, next);

    await interaction.update({
      content: mode === "remove"
        ? L(
          `Removed ${selected.length} skill(s). Total attached: ${next.length}`,
          `${selected.length}개 스킬을 제거했습니다. 현재 연결된 스킬: ${next.length}개`,
        )
        : L(
          `Added ${selected.length} skill(s). Total attached: ${next.length}`,
          `${selected.length}개 스킬을 추가했습니다. 현재 연결된 스킬: ${next.length}개`,
        ),
      components: [],
    });
    return;
  }

  if (interaction.customId.startsWith("ask-select:")) {
    const askRequestId = interaction.customId.slice("ask-select:".length);
    const options = (interaction.component as any).options ?? [];
    const selectedLabels = interaction.values.map((val: string) => {
      const opt = options.find((o: any) => o.value === val);
      return opt?.label ?? val;
    });
    const answer = selectedLabels.join(", ");

    const resolved = sessionManager.resolveQuestion(askRequestId, answer);
    if (!resolved) {
      await interaction.reply({ content: L("This question has expired.", "이 질문은 만료되었습니다."), ephemeral: true });
      return;
    }

    await interaction.update({
      content: L(`✅ Selected: **${answer}**`, `✅ 선택됨: **${answer}**`),
      embeds: [],
      components: [],
    });
    return;
  }

  if (interaction.customId !== "session-select") {
    return;
  }

  const selectedSessionId = interaction.values[0];
  if (selectedSessionId === "__new_session__") {
    const channelId = interaction.channelId;
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), channelId, null, "idle");

    await interaction.update({
      embeds: [
        {
          title: L("✨ New Session", "✨ 새 세션"),
          description: L("New session is ready.\nA new conversation will start from your next message.", "새 세션이 준비되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다."),
          color: 0x00ff00,
        },
      ],
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const channelId = interaction.channelId;
  const project = getProject(channelId);
  let lastMessage = "";
  if (project) {
    const sessionDir = findSessionDir(project.project_path);
    if (sessionDir) {
      const filePath = path.join(sessionDir, `${selectedSessionId}.jsonl`);
      try {
        lastMessage = await getLastAssistantMessage(filePath);
      } catch {
        // ignore
      }
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`session-resume:${selectedSessionId}`)
      .setLabel(L("Resume", "재개"))
      .setStyle(ButtonStyle.Success)
      .setEmoji("▶️"),
    new ButtonBuilder()
      .setCustomId(`session-delete:${selectedSessionId}`)
      .setLabel(L("Delete", "삭제"))
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🗑️"),
    new ButtonBuilder()
      .setCustomId("session-cancel:_")
      .setLabel(L("Cancel", "취소"))
      .setStyle(ButtonStyle.Secondary),
  );

  const preview = lastMessage && lastMessage !== "(no message)"
    ? `\n\n${L("**Last conversation:**", "**마지막 대화:**")}\n${lastMessage.slice(0, 300)}${lastMessage.length > 300 ? "..." : ""}`
    : "";

  await interaction.editReply({
    embeds: [
      {
        title: L("Session Selected", "세션 선택됨"),
        description: L(`Session: \`${selectedSessionId.slice(0, 8)}...\`\n\nResume or delete this session?`, `세션: \`${selectedSessionId.slice(0, 8)}...\`\n\n이 세션을 재개 또는 삭제하시겠습니까?`) + preview,
        color: 0x7c3aed,
      },
    ],
    components: [row],
  });
}

export async function handleModalSubmitInteraction(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  console.log(`[handleModalSubmitInteraction] customId=${interaction.customId}`);
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === "project-search-modal") {
    const channelId = interaction.channelId;
    if (!channelId) {
      await interaction.reply({
        content: L("Channel context is unavailable.", "채널 정보를 찾을 수 없습니다."),
        ephemeral: true,
      });
      return;
    }
    const query = interaction.fields.getTextInputValue("query");
    setPickerQuery(channelId, query);
    if ("message" in interaction && interaction.message && "edit" in interaction.message) {
      await interaction.message.edit(buildProjectPickerView(channelId) as MessageEditOptions);
    }
    await interaction.reply({
      content: query
        ? L(`Search applied: \`${query}\``, `검색 적용: \`${query}\``)
        : L("Search cleared.", "검색이 해제되었습니다."),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === "project-create-modal") {
    const channelId = interaction.channelId;
    if (!channelId) {
      await interaction.reply({
        content: L("Channel context is unavailable.", "채널 정보를 찾을 수 없습니다."),
        ephemeral: true,
      });
      return;
    }
    const folderName = interaction.fields.getTextInputValue("folder");
    const result = createPickerFolder(channelId, folderName);
    if (!result.ok) {
      const msg = result.error === "exists"
        ? L("Folder already exists.", "이미 존재하는 폴더입니다.")
        : result.error === "invalid"
        ? L("Invalid folder name.", "유효하지 않은 폴더 이름입니다.")
        : L("Folder name is required.", "폴더 이름이 필요합니다.");
      await interaction.reply({ content: msg, ephemeral: true });
      return;
    }

    setPickerDir(channelId, result.path!);
    if ("message" in interaction && interaction.message && "edit" in interaction.message) {
      await interaction.message.edit(buildProjectPickerView(channelId) as MessageEditOptions);
    }
    await interaction.reply({
      content: L(`Created folder: \`${result.path}\``, `폴더 생성됨: \`${result.path}\``),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId.startsWith("progress-review-adversarial-modal:")) {
    const checkpointId = extractCheckpointIdFromRequest(
      interaction.customId.slice("progress-review-adversarial-modal:".length),
    );
    const scopeId = interaction.channelId;
    const projectChannelId = getProjectChannelIdFromInteraction(interaction as unknown as ButtonInteraction);
    const checkpoint = checkpointId && checkpointId !== "_" ? getCheckpoint(checkpointId) : getLastCheckpoint(scopeId);
    const project = getProject(projectChannelId);
    if (!project) {
      await interaction.reply({
        content: L("Project not found.", "프로젝트를 찾을 수 없습니다."),
        ephemeral: true,
      });
      return;
    }

    if (checkpoint) {
      updateCheckpointStatus(checkpoint.id, "reviewed");
    }

    const base = interaction.fields.getTextInputValue("base");
    const focus = interaction.fields.getTextInputValue("focus");
    const command = buildCodexReviewCommand("adversarial", base, focus);
    if (checkpoint?.resumeSessionId) {
      resumeStoredSession(scopeId, projectChannelId, checkpoint.resumeSessionId, interaction);
    }

    await interaction.reply({
      content: L(
        `Starting Codex adversarial review in background.\n\`${command}\``,
        `Codex adversarial 리뷰를 백그라운드로 시작합니다.\n\`${command}\``,
      ),
      ephemeral: true,
    });

    await sessionManager.sendMessage(interaction.channel as any, command, {
      scopeId,
      projectChannelId,
    });
    return;
  }

}
