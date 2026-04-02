import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { isAllowedUser } from "../../security/guard.js";
import { sessionManager } from "../../claude/session-manager.js";
import {
  upsertSession,
  getProject,
  getSession,
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
import { buildDefaultOpsHint, buildSkillIntro } from "../../utils/skills.js";
import { getPickerDir, listPickerOptions, movePickerUp, setPickerDir } from "../project-picker.js";

async function showProjectPicker(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const existing = getProject(interaction.channelId);
  const { rootDir, currentDir, options } = listPickerOptions(interaction.channelId);

  if (options.length === 0) {
    await interaction.update({
      content: L(`No folders found under \`${currentDir}\`.`, `\`${currentDir}\` 아래에 폴더가 없습니다.`),
      embeds: [],
      components: [],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("project-select")
    .setPlaceholder(L("Choose a project folder", "프로젝트 폴더를 선택하세요"))
    .addOptions(options);

  await interaction.update({
    embeds: [
      {
        title: L("Project Picker", "프로젝트 선택"),
        description: existing
          ? L(
            `Current project: \`${existing.project_path}\`\n\nBrowsing: \`${currentDir}\`\nRoot: \`${rootDir}\``,
            `현재 프로젝트: \`${existing.project_path}\`\n\n현재 탐색 경로: \`${currentDir}\`\n루트: \`${rootDir}\``,
          )
          : L(
            `Select a project under \`${currentDir}\`.\nRoot: \`${rootDir}\``,
            `\`${currentDir}\` 아래 프로젝트를 선택하세요.\n루트: \`${rootDir}\``,
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
          .setCustomId("project-refresh:_")
          .setLabel(L("Refresh", "새로고침"))
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
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
    await thread.send(
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
    await threadChannel.send(
      [
        L(`Continuing topic:\n> ${pending.prompt}`, `주제를 이어갑니다:\n> ${pending.prompt}`),
        buildSkillIntro(selectedSkills),
      ].filter(Boolean).join("\n\n"),
    );
    await sessionManager.sendMessage(threadChannel as any, pending.prompt, {
      scopeId: threadChannel.id,
      projectChannelId: channelId,
      topic: latest?.topic ?? threadChannel.name,
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
      content: L(`📨 Message added to queue (${queueSize}/5). It will be processed after the current task.`, `📨 메시지가 큐에 추가되었습니다 (${queueSize}/5). 이전 작업 완료 후 자동으로 처리됩니다.`),
      components: [],
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
    const channelId = interaction.channelId;
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), channelId, sessionId, "idle");

    await interaction.update({
      embeds: [
        {
          title: L("Session Resumed", "세션 재개됨"),
          description: L(
            `Session: \`${sessionId.slice(0, 8)}...\`\n\nNext message you send will resume this conversation.`,
            `세션: \`${sessionId.slice(0, 8)}...\`\n\n다음 메시지부터 이 대화가 재개됩니다.`,
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
