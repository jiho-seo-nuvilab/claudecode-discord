import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getProject } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";

const execAsync = promisify(exec);

export const data = new SlashCommandBuilder()
  .setName("cc-test")
  .setDescription("Run tests for the registered project");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const projectChannelId = getProjectChannelIdFromInteraction(interaction);
  const project = getProject(projectChannelId);

  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project.",
        "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다.",
      ),
    });
    return;
  }

  const startTime = Date.now();
  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle(L("Running Tests", "테스트 실행 중"))
    .setDescription(L("Executing `npm test` for your project...", "프로젝트 테스트를 실행하고 있습니다..."))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  try {
    const { stdout } = await execAsync("npm test 2>&1", {
      cwd: project.project_path,
      timeout: 60000, // 60초 타임아웃
    });

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const truncated = stdout.length > 1900 ? stdout.substring(0, 1900) + "\n... (truncated)" : stdout;

    const successEmbed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle(L("✅ Tests Passed", "✅ 테스트 성공"))
      .setDescription(`\`\`\`\n${truncated}\n\`\`\``)
      .addFields({
        name: L("Time", "소요시간"),
        value: `${elapsedTime}s`,
        inline: true,
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [successEmbed] });
  } catch (error: unknown) {
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const errorMsg = error instanceof Error ? error.message : String(error);
    const truncated = errorMsg.length > 1900 ? errorMsg.substring(0, 1900) + "\n... (truncated)" : errorMsg;

    const failureEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle(L("❌ Tests Failed", "❌ 테스트 실패"))
      .setDescription(`\`\`\`\n${truncated}\n\`\`\``)
      .addFields({
        name: L("Time", "소요시간"),
        value: `${elapsedTime}s`,
        inline: true,
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [failureEmbed] });
  }
}
