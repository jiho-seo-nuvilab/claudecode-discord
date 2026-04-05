import { ChatInputCommandInteraction, SlashCommandBuilder, type TextChannel } from "discord.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";
import {
  DEFAULT_CODEX_MODEL,
  buildCodexCancelCommand,
  buildCodexRescueCommand,
  buildCodexResultCommand,
  buildCodexReviewCommand,
  buildCodexStatusCommand,
  resolveCodexModel,
} from "../../utils/codex.js";
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
      )
      .addStringOption((opt) =>
        opt
          .setName("model")
          .setDescription(`Override Codex model (default: ${DEFAULT_CODEX_MODEL})`)
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("review")
      .setDescription("Run a Codex review")
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Review mode")
          .addChoices(
            { name: "normal", value: "normal" },
            { name: "adversarial", value: "adversarial" },
          )
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("base")
          .setDescription("Optional base ref for review diff")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("focus")
          .setDescription("Optional extra focus text")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("model")
          .setDescription(`Override Codex model (default: ${DEFAULT_CODEX_MODEL})`)
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Show Codex background task status")
      .addStringOption((opt) =>
        opt
          .setName("model")
          .setDescription("Accepted for UX consistency; status itself does not launch a new model run")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("result")
      .setDescription("Fetch latest Codex result")
      .addStringOption((opt) =>
        opt
          .setName("model")
          .setDescription("Accepted for UX consistency; result itself does not launch a new model run")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Cancel active Codex task")
      .addStringOption((opt) =>
        opt
          .setName("model")
          .setDescription("Accepted for UX consistency; cancel itself does not launch a new model run")
          .setRequired(false),
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
        `- \`/cc-codex rescue task:<...>\` delegate a complex task (default model: ${DEFAULT_CODEX_MODEL})`,
        `- \`/cc-codex review mode:normal|adversarial\` run a review (default model: ${DEFAULT_CODEX_MODEL})`,
        "- `/cc-codex status` show current background tasks",
        "- `/cc-codex result` fetch latest result",
        "- `/cc-codex cancel` stop the active Codex task",
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

  const dispatchCodexCommand = async (command: string, startedText: string, queuedText: string): Promise<void> => {
    const channel = interaction.channel as TextChannel;
    if (sessionManager.isActive(scopeId)) {
      if (sessionManager.isQueueFull(scopeId)) {
        await interaction.editReply({
          content: L("Queue is full (max 5). Please wait for current tasks to finish.", "큐가 가득 찼습니다 (최대 5개). 현재 작업 완료 후 다시 시도해 주세요."),
        });
        return;
      }
      sessionManager.enqueueMessage(scopeId, channel, command);
      await interaction.editReply({
        content: queuedText,
      });
      return;
    }

    await interaction.editReply({
      content: startedText,
    });
    await sessionManager.sendMessage(channel, command, {
      scopeId,
      projectChannelId,
      topic: interaction.channel?.isThread() ? interaction.channel.name : null,
    });
  };

  if (sub === "rescue") {
    const task = interaction.options.getString("task", true).trim();
    const model = resolveCodexModel(interaction.options.getString("model"));
    const prompt = buildCodexRescueCommand([
      "Please take ownership of this complex task end-to-end.",
      `Task: ${task}`,
      "Return: summary, changed files, verification results, and next steps.",
    ].join("\n"), model);

    await dispatchCodexCommand(
      prompt,
      L(`Starting rescue task now with \`${model}\`.`, `Rescue 작업을 \`${model}\`로 바로 시작합니다.`),
      L(
        `Queued rescue task with \`${model}\`. Queue size: ${sessionManager.getQueueSize(scopeId)}`,
        `\`${model}\`로 Rescue 작업을 큐에 추가했습니다. 큐 크기: ${sessionManager.getQueueSize(scopeId)}`,
      ),
    );
    return;
  }

  if (sub === "review") {
    const mode = (interaction.options.getString("mode") as "normal" | "adversarial" | null) ?? "normal";
    const base = interaction.options.getString("base") ?? undefined;
    const focus = interaction.options.getString("focus") ?? undefined;
    const model = resolveCodexModel(interaction.options.getString("model"));
    const command = buildCodexReviewCommand(mode, base, focus, model);

    await dispatchCodexCommand(
      command,
      L(`Starting ${mode} review with \`${model}\`.`, `\`${model}\`로 ${mode} 리뷰를 시작합니다.`),
      L(
        `Queued ${mode} review with \`${model}\`. Queue size: ${sessionManager.getQueueSize(scopeId)}`,
        `\`${model}\`로 ${mode} 리뷰를 큐에 추가했습니다. 큐 크기: ${sessionManager.getQueueSize(scopeId)}`,
      ),
    );
    return;
  }

  if (sub === "status") {
    const command = buildCodexStatusCommand();
    await dispatchCodexCommand(
      command,
      L("Checking Codex status now.", "Codex 상태를 바로 확인합니다."),
      L(
        `Queued Codex status check. Queue size: ${sessionManager.getQueueSize(scopeId)}`,
        `Codex 상태 확인을 큐에 추가했습니다. 큐 크기: ${sessionManager.getQueueSize(scopeId)}`,
      ),
    );
    return;
  }

  if (sub === "result") {
    const command = buildCodexResultCommand();
    await dispatchCodexCommand(
      command,
      L("Fetching Codex result now.", "Codex 결과를 바로 가져옵니다."),
      L(
        `Queued Codex result fetch. Queue size: ${sessionManager.getQueueSize(scopeId)}`,
        `Codex 결과 조회를 큐에 추가했습니다. 큐 크기: ${sessionManager.getQueueSize(scopeId)}`,
      ),
    );
    return;
  }

  if (sub === "cancel") {
    const command = buildCodexCancelCommand();
    await dispatchCodexCommand(
      command,
      L("Cancelling Codex task now.", "Codex 작업을 바로 취소합니다."),
      L(
        `Queued Codex cancel request. Queue size: ${sessionManager.getQueueSize(scopeId)}`,
        `Codex 취소 요청을 큐에 추가했습니다. 큐 크기: ${sessionManager.getQueueSize(scopeId)}`,
      ),
    );
    return;
  }
}
