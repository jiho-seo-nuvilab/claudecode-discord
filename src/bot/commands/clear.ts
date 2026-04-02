import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { clearProjectSessions, getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";
import fs from "node:fs";
import path from "node:path";
import { findSessionDir } from "./sessions.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";

export const data = new SlashCommandBuilder()
  .setName("cc-clear")
  .setDescription("Clear saved Claude sessions for this project");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const projectChannelId = getProjectChannelIdFromInteraction(interaction);
  const project = getProject(projectChannelId);
  if (!project) {
    await interaction.editReply({
      content: L("This channel is not registered to any project.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다."),
    });
    return;
  }

  await sessionManager.stopSession(interaction.channelId);
  const sessionDir = findSessionDir(project.project_path);
  if (!sessionDir) {
    await interaction.editReply({
      content: L(`No session directory found for \`${project.project_path}\`.`, `\`${project.project_path}\`에 대한 세션 디렉토리를 찾을 수 없습니다.`),
    });
    return;
  }

  const files = fs.readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
  for (const file of files) {
    fs.unlinkSync(path.join(sessionDir, file));
  }

  clearProjectSessions(projectChannelId);

  await interaction.editReply({
    content: L(
      `Cleared ${files.length} saved Claude session file(s) and reset tracked thread sessions.`,
      `${files.length}개의 Claude 세션 파일을 정리했고 추적 중인 스레드 세션도 초기화했습니다.`,
    ),
  });
}
