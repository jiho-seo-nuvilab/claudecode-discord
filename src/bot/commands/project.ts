import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";
import path from "node:path";
import { getProject } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { buildDefaultOpsHint } from "../../utils/skills.js";
import { listPickerOptions, setPickerDir } from "../project-picker.js";

export const data = new SlashCommandBuilder()
  .setName("cc-project")
  .setDescription("Project home actions for this channel")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Pick a project folder for this channel"),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "add") return;

  const existing = getProject(interaction.channelId);
  const { rootDir, currentDir, options } = listPickerOptions(interaction.channelId);
  setPickerDir(interaction.channelId, currentDir);

  if (options.length === 0) {
    await interaction.editReply({
      content: L(
        `No folders found under \`${currentDir}\`.`,
        `\`${currentDir}\` 아래에 폴더가 없습니다.`,
      ),
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("project-select")
    .setPlaceholder(L("Choose a project folder", "프로젝트 폴더를 선택하세요"))
    .addOptions(options);

  const refresh = new ButtonBuilder()
    .setCustomId("project-refresh:_")
    .setLabel(L("Refresh", "새로고침"))
    .setStyle(ButtonStyle.Secondary);
  const up = new ButtonBuilder()
    .setCustomId("project-up:_")
    .setLabel(L("Up", "상위로"))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(path.resolve(currentDir) === path.resolve(rootDir));

  await interaction.editReply({
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
        fields: [
          {
            name: L("Shortcuts", "바로가기"),
            value: buildDefaultOpsHint().slice(0, 1024),
            inline: false,
          },
        ],
      },
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(up, refresh),
    ],
  });
}
