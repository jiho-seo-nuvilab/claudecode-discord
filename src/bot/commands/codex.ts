import { ChatInputCommandInteraction, SlashCommandBuilder, type TextChannel } from "discord.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";

export const data = new SlashCommandBuilder()
  .setName("cc-codex")
  .setDescription("Codex helper commands")
  .addSubcommand((sub) =>
    sub
      .setName("rescue")
      .setDescription("Delegate a complex task to Codex")
      .addStringOption((opt) =>
        opt
          .setName("task")
          .setDescription("What Codex should handle")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("gpt-5-4-prompting")
      .setDescription("Show practical GPT-5.4 prompting tips"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("help")
      .setDescription("Show codex quick actions"),
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

  const sub = interaction.options.getSubcommand();
  if (sub === "help") {
    await interaction.editReply({
      content: [
        "Codex quick actions:",
        "- `/cc-codex rescue task:<...>` delegate a complex task",
        "- `/cc-codex gpt-5-4-prompting` get prompting guide",
        "- `/cc-btw question:<...>` side question without interrupting",
      ].join("\n"),
    });
    return;
  }

  if (sub === "gpt-5-4-prompting") {
    await interaction.editReply({
      content: [
        "GPT-5.4 prompting quick guide:",
        "1. Give exact goal + success criteria",
        "2. Provide concrete files/paths and constraints",
        "3. Ask for verification commands and expected outcomes",
        "4. For long tasks, ask for milestones + checkpoints",
        "5. Specify scope clearly (what to change / what not to touch)",
      ].join("\n"),
    });
    return;
  }

  const task = interaction.options.getString("task", true).trim();
  const prompt = [
    "[Codex Rescue]",
    "Please take ownership of this complex task end-to-end.",
    `Task: ${task}`,
    "Return: summary, changed files, verification results, and next steps.",
  ].join("\n");

  const channel = interaction.channel as TextChannel;
  if (sessionManager.isActive(scopeId)) {
    if (sessionManager.isQueueFull(scopeId)) {
      await interaction.editReply({
        content: L("Queue is full (max 5). Please wait for current tasks to finish.", "큐가 가득 찼습니다 (최대 5개). 현재 작업 완료 후 다시 시도해 주세요."),
      });
      return;
    }
    sessionManager.enqueueMessage(scopeId, channel, prompt);
    await interaction.editReply({
      content: L(
        `Queued rescue task. Queue size: ${sessionManager.getQueueSize(scopeId)}`,
        `Rescue 작업을 큐에 추가했습니다. 큐 크기: ${sessionManager.getQueueSize(scopeId)}`,
      ),
    });
    return;
  }

  await interaction.editReply({
    content: L("Starting rescue task now.", "Rescue 작업을 바로 시작합니다."),
  });
  await sessionManager.sendMessage(channel, prompt, {
    scopeId,
    projectChannelId,
    topic: interaction.channel?.isThread() ? interaction.channel.name : null,
  });
}
