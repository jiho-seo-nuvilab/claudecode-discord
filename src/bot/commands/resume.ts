import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getProject, getThreadSession, upsertSession, upsertThreadSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";
import { listSessions } from "./sessions.js";

export const data = new SlashCommandBuilder()
  .setName("cc-resume")
  .setDescription("Resume a previous Claude session quickly")
  .addSubcommand((sub) =>
    sub
      .setName("latest")
      .setDescription("Resume the latest saved session for this project"),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const scopeId = interaction.channelId;
  const projectChannelId = getProjectChannelIdFromInteraction(interaction);
  const project = getProject(projectChannelId);

  if (!project) {
    await interaction.editReply({
      content: L("This channel is not registered to any project.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다."),
    });
    return;
  }

  const sessions = await listSessions(project.project_path);
  if (sessions.length === 0) {
    await interaction.editReply({
      content: L("No saved sessions found for this project.", "이 프로젝트에 저장된 세션이 없습니다."),
    });
    return;
  }

  const latest = sessions[0];
  if (scopeId === projectChannelId) {
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), projectChannelId, latest.sessionId, "idle");
  } else {
    const existing = getThreadSession(scopeId);
    const threadName =
      interaction.channel && interaction.channel.isThread() ? interaction.channel.name : null;
    upsertThreadSession(
      scopeId,
      projectChannelId,
      latest.sessionId,
      "idle",
      existing?.topic ?? threadName,
    );
  }

  await interaction.editReply({
    content: L(
      `Resumed latest session: \`${latest.sessionId.slice(0, 8)}...\`\nNext message will continue that conversation.`,
      `최신 세션을 재개했습니다: \`${latest.sessionId.slice(0, 8)}...\`\n다음 메시지부터 해당 대화를 이어갑니다.`,
    ),
  });
}
