import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { isAllowedUser } from "../../security/guard.js";
import { sessionManager } from "../../claude/session-manager.js";
import { upsertSession, getProject } from "../../db/database.js";
import { findSessionDir, getLastAssistantMessage } from "../commands/sessions.js";

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: "You are not authorized.",
      ephemeral: true,
    });
    return;
  }

  const customId = interaction.customId;
  // Use split with limit to handle session IDs that might contain colons
  const colonIndex = customId.indexOf(":");
  const action = colonIndex === -1 ? customId : customId.slice(0, colonIndex);
  const requestId = colonIndex === -1 ? "" : customId.slice(colonIndex + 1);

  if (!requestId) {
    await interaction.reply({
      content: "Invalid button interaction.",
      ephemeral: true,
    });
    return;
  }

  // Handle stop button
  if (action === "stop") {
    const channelId = requestId;
    const stopped = await sessionManager.stopSession(channelId);
    await interaction.update({
      content: "⏹️ 작업이 중지되었습니다.",
      components: [],
    });
    if (!stopped) {
      await interaction.followUp({
        content: "활성 세션이 없습니다.",
        ephemeral: true,
      });
    }
    return;
  }

  // Handle queue confirmation
  if (action === "queue-yes") {
    const channelId = requestId;
    const confirmed = sessionManager.confirmQueue(channelId);
    if (!confirmed) {
      await interaction.update({
        content: "⏳ 큐 요청이 만료되었습니다.",
        components: [],
      });
      return;
    }
    await interaction.update({
      content: "📨 메시지가 큐에 추가되었습니다. 이전 작업 완료 후 자동으로 처리됩니다.",
      components: [],
    });
    return;
  }

  // Handle queue cancellation
  if (action === "queue-no") {
    const channelId = requestId;
    sessionManager.cancelQueue(channelId);
    await interaction.update({
      content: "취소되었습니다.",
      components: [],
    });
    return;
  }

  // Handle session resume button
  if (action === "session-resume") {
    const sessionId = requestId;
    const channelId = interaction.channelId;
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), channelId, sessionId, "idle");

    await interaction.update({
      embeds: [
        {
          title: "Session Resumed",
          description: [
            `Session: \`${sessionId.slice(0, 8)}...\``,
            "",
            "Next message you send will resume this conversation.",
          ].join("\n"),
          color: 0x00ff00,
        },
      ],
      components: [],
    });
    return;
  }

  // Handle session cancel button
  if (action === "session-cancel") {
    await interaction.update({
      content: "Cancelled.",
      embeds: [],
      components: [],
    });
    return;
  }

  // Handle AskUserQuestion option selection
  if (action === "ask-opt") {
    // requestId format: "uuid:optionIndex"
    const lastColon = requestId.lastIndexOf(":");
    const actualRequestId = requestId.slice(0, lastColon);
    const selectedLabel = interaction.component.label ?? "Unknown";

    const resolved = sessionManager.resolveQuestion(actualRequestId, selectedLabel);
    if (!resolved) {
      await interaction.reply({ content: "This question has expired.", ephemeral: true });
      return;
    }

    await interaction.update({
      content: `✅ Selected: **${selectedLabel}**`,
      embeds: [],
      components: [],
    });
    return;
  }

  // Handle AskUserQuestion custom text input
  if (action === "ask-other") {
    sessionManager.enableCustomInput(requestId, interaction.channelId);

    await interaction.update({
      content: "✏️ 답변을 입력하세요...",
      embeds: [],
      components: [],
    });
    return;
  }

  // Handle session delete button
  if (action === "session-delete") {
    const sessionId = requestId;
    const channelId = interaction.channelId;
    const project = getProject(channelId);

    if (!project) {
      await interaction.update({
        content: "Project not found.",
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
        await interaction.update({
          embeds: [
            {
              title: "Session Deleted",
              description: `Session \`${sessionId.slice(0, 8)}...\` has been deleted.`,
              color: 0xff6b6b,
            },
          ],
          components: [],
        });
      } catch {
        await interaction.update({
          content: "Failed to delete session file.",
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
      content: "This approval request has expired.",
      ephemeral: true,
    });
    return;
  }

  const labels: Record<string, string> = {
    approve: "✅ Approved",
    deny: "❌ Denied",
    "approve-all": "⚡ Auto-approve enabled for this channel",
  };

  await interaction.update({
    content: labels[decision],
    components: [], // remove buttons
  });
}

export async function handleSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: "You are not authorized.",
      ephemeral: true,
    });
    return;
  }

  // Handle AskUserQuestion multi-select
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
      await interaction.reply({ content: "This question has expired.", ephemeral: true });
      return;
    }

    await interaction.update({
      content: `✅ Selected: **${answer}**`,
      embeds: [],
      components: [],
    });
    return;
  }

  if (interaction.customId === "session-select") {
    const selectedSessionId = interaction.values[0];

    // Handle "New Session" option
    if (selectedSessionId === "__new_session__") {
      const channelId = interaction.channelId;
      const { randomUUID } = await import("node:crypto");
      // Set session_id to null so next message creates a fresh session
      upsertSession(randomUUID(), channelId, null, "idle");

      await interaction.update({
        embeds: [
          {
            title: "✨ New Session",
            description: "새 세션이 준비되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다.",
            color: 0x00ff00,
          },
        ],
        components: [],
      });
      return;
    }

    // Defer first to avoid 3s timeout while reading JSONL
    await interaction.deferUpdate();

    // Read last assistant message from session file
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

    // Show Resume / Delete buttons
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`session-resume:${selectedSessionId}`)
        .setLabel("Resume")
        .setStyle(ButtonStyle.Success)
        .setEmoji("▶️"),
      new ButtonBuilder()
        .setCustomId(`session-delete:${selectedSessionId}`)
        .setLabel("Delete")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🗑️"),
      new ButtonBuilder()
        .setCustomId(`session-cancel:_`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    );

    const preview = lastMessage && lastMessage !== "(no message)"
      ? `\n\n**마지막 대화:**\n${lastMessage.slice(0, 300)}${lastMessage.length > 300 ? "..." : ""}`
      : "";

    await interaction.editReply({
      embeds: [
        {
          title: "Session Selected",
          description: `Session: \`${selectedSessionId.slice(0, 8)}...\`\n\nResume or delete this session?${preview}`,
          color: 0x7c3aed,
        },
      ],
      components: [row],
    });
  }
}
