import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import path from "node:path";
import { getProject, getSession, getThreadSession } from "../../db/database.js";
import { findSessionDir, getLastAssistantMessageFull } from "./sessions.js";
import { splitMessage } from "../../claude/output-formatter.js";
import { L } from "../../utils/i18n.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";

export const data = new SlashCommandBuilder()
  .setName("cc-last")
  .setDescription("Show the last Claude response from the current session");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const scopeId = interaction.channelId;
  const projectChannelId = getProjectChannelIdFromInteraction(interaction);
  const project = getProject(projectChannelId);

  if (!project) {
    await interaction.editReply({
      content: L("This channel is not registered to any project. Use `/cc-register` first.", "이 채널은 프로젝트에 등록되지 않았습니다. `/cc-register`를 먼저 사용하세요."),
    });
    return;
  }

  const session = scopeId === projectChannelId
    ? getSession(projectChannelId)
    : getThreadSession(scopeId);
  if (!session?.session_id) {
    await interaction.editReply({
      content: L("No active session. Select a session from `/cc-sessions`.", "활성 세션이 없습니다. `/cc-sessions`에서 세션을 선택하세요."),
    });
    return;
  }

  const sessionDir = findSessionDir(project.project_path);
  if (!sessionDir) {
    await interaction.editReply({
      content: L("Session directory not found.", "세션 디렉토리를 찾을 수 없습니다."),
    });
    return;
  }

  const filePath = path.join(sessionDir, `${session.session_id}.jsonl`);

  let lastMessage: string;
  try {
    lastMessage = await getLastAssistantMessageFull(filePath);
  } catch {
    await interaction.editReply({
      content: L("Cannot read session file.", "세션 파일을 읽을 수 없습니다."),
    });
    return;
  }

  if (lastMessage === "(no message)") {
    await interaction.editReply({
      content: L("No Claude response in this session.", "이 세션에 Claude 응답이 없습니다."),
    });
    return;
  }

  // Split into Discord-safe chunks
  const chunks = splitMessage(lastMessage);

  await interaction.editReply({ content: chunks[0] });

  // Send remaining chunks as follow-ups
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i] });
  }
}
