import { ChatInputCommandInteraction, SlashCommandBuilder, type TextChannel } from "discord.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";

export const data = new SlashCommandBuilder()
  .setName("cc-btw")
  .setDescription("Ask a quick side question without interrupting the main conversation")
  .addStringOption((opt) =>
    opt
      .setName("question")
      .setDescription("Side question to ask")
      .setRequired(true),
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

  const question = interaction.options.getString("question", true).trim();
  const prompt = `[BTW side question]\n${question}`;
  const channel = interaction.channel as TextChannel;

  if (!sessionManager.isActive(scopeId)) {
    await interaction.editReply({
      content: L("No active session in this scope, so I sent it now.", "현재 범위에 활성 세션이 없어 바로 전송했습니다."),
    });
    await sessionManager.sendMessage(channel, prompt, {
      scopeId,
      projectChannelId,
      topic: interaction.channel?.isThread() ? interaction.channel.name : null,
    });
    return;
  }

  if (sessionManager.isQueueFull(scopeId)) {
    await interaction.editReply({
      content: L("Queue is full (max 5). Please wait for current tasks to finish.", "큐가 가득 찼습니다 (최대 5개). 현재 작업 완료 후 다시 시도해 주세요."),
    });
    return;
  }

  const queued = sessionManager.enqueueMessage(scopeId, channel, prompt);
  if (!queued) {
    await interaction.editReply({
      content: L("Could not queue this side question. Please try again.", "사이드 질문을 큐에 넣지 못했습니다. 다시 시도해 주세요."),
    });
    return;
  }

  await interaction.editReply({
    content: L(
      `Queued as BTW. Current queue size: ${sessionManager.getQueueSize(scopeId)}`,
      `BTW로 큐에 추가했습니다. 현재 큐 크기: ${sessionManager.getQueueSize(scopeId)}`,
    ),
  });
}
